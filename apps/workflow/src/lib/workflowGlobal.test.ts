/**
 * `window.__workflow` (07/D12) is a **contract**: the headless driver reads it
 * to follow a run it started, so its shape is pinned here rather than left to
 * whatever the page happens to have handy.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { publishWorkflowGlobal, snapshotOf } from './workflowGlobal'
import type { RunState, StepState, StepStatus } from './runner/types'

afterEach(() => {
  publishWorkflowGlobal(null)
})

function step(key: string, status: StepStatus, outputs?: Record<string, unknown>): StepState {
  const [job = '', index = '0', stepId = ''] = key.split('/')
  return {
    key,
    job,
    index: Number(index),
    stepId,
    kind: 'pipeline',
    status,
    attempt: 1,
    annotations: [],
    ...(outputs === undefined ? {} : { outputs }),
  }
}

// `steps` is `Record<string, StepState>` on RunState and a list here, so the
// list has to *replace* that member rather than intersect with it — an
// intersection makes the parameter unsatisfiable and only `tsc -b` says so
// (vitest transpiles without typechecking).
function runState(a: Omit<Partial<RunState>, 'steps'> & { steps?: StepState[] } = {}): RunState {
  const steps: Record<string, StepState> = {}
  for (const s of a.steps ?? []) steps[s.key] = s
  return {
    runId: 'run_1',
    impl: 'hello',
    workflow: 'hello',
    status: 'running',
    headless: true,
    unattended: false,
    inputs: {},
    expansions: {},
    annotations: [],
    startedAt: 1_000,
    ...a,
    steps,
  }
}

describe('publishWorkflowGlobal', () => {
  it('writes the snapshot onto `window.__workflow`', () => {
    const snapshot = {
      runId: 'run_1',
      status: 'running' as const,
      currentSteps: ['a/0/x'],
      outputs: {},
      steps: { 'a/0/x': 'running' as const },
    }
    publishWorkflowGlobal(snapshot)
    expect(window.__workflow).toEqual(snapshot)
  })

  it('clears it on `null`, so a driver never reads a page that is gone', () => {
    publishWorkflowGlobal({
      runId: 'run_1',
      status: 'succeeded',
      currentSteps: [],
      outputs: {},
      steps: {},
    })
    publishWorkflowGlobal(null)
    expect(window.__workflow).toBeUndefined()
    expect('__workflow' in window).toBe(false)
  })
})

describe('snapshotOf', () => {
  it('reports the run id, status, per-step statuses and outputs', () => {
    const state = runState({
      status: 'succeeded',
      outputs: { report: 'ok' },
      steps: [step('a/0/x', 'succeeded'), step('b/0/y', 'skipped')],
    })
    expect(snapshotOf(state)).toEqual({
      runId: 'run_1',
      status: 'succeeded',
      currentSteps: [],
      outputs: { report: 'ok' },
      steps: { 'a/0/x': 'succeeded', 'b/0/y': 'skipped' },
    })
  })

  it('counts `running`, `polling` and `waiting` as the current steps — nothing else', () => {
    const state = runState({
      steps: [
        step('a/0/queued', 'queued'),
        step('a/0/running', 'running'),
        step('a/0/polling', 'polling'),
        step('a/0/waiting', 'waiting'),
        step('a/0/done', 'succeeded'),
        step('a/0/failed', 'failed'),
        step('a/0/skipped', 'skipped'),
        step('a/0/cancelled', 'cancelled'),
      ],
    })
    expect(snapshotOf(state).currentSteps.sort()).toEqual([
      'a/0/polling',
      'a/0/running',
      'a/0/waiting',
    ])
  })

  it('reports `{}` for a run that has produced no outputs yet', () => {
    expect(snapshotOf(runState()).outputs).toEqual({})
  })

  it('carries no `errors` key for a run — that half is the invalid-kickoff case', () => {
    expect('errors' in snapshotOf(runState())).toBe(false)
  })
})
