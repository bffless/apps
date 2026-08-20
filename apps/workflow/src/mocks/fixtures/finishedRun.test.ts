/**
 * The fixture is only useful if it is a *replayable* record: Task 15's run page
 * rebuilds its state with the very same `replayRun` the resumed live run uses,
 * so a row the engine cannot fold is a broken fixture, not a UI bug.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it } from 'vitest'
import { replayRun } from '../../lib/runner/replay'
import type { StepStatus } from '../../lib/runner/types'
import { FINISHED_RUN } from './finishedRun'

const TERMINAL: StepStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled']

describe('FINISHED_RUN', () => {
  const state = replayRun(
    FINISHED_RUN.run,
    FINISHED_RUN.steps,
    toDefinition(FINISHED_RUN.run.definition),
  )

  it('replays into a finished run of six terminal steps (R2)', () => {
    expect(state.status).toBe('succeeded')
    expect(Object.keys(state.steps)).toHaveLength(6)
    for (const step of Object.values(state.steps)) {
      expect(TERMINAL, step.key).toContain(step.status)
    }
  })

  it('keeps the retried attempt and the run outputs', () => {
    expect(state.steps['slow/0/start'].attempt).toBe(2)
    expect(state.outputs?.lines).toEqual(FINISHED_RUN.run.outputs?.lines)
    expect(state.startedBy).toBe(FINISHED_RUN.run.startedBy)
  })

  it('has one row per step of the hello workflow, in the recorded shapes', () => {
    expect(FINISHED_RUN.steps.map((s) => s.key)).toEqual([
      'greet/0/say',
      'greet/1/say',
      'slow/0/start',
      'flaky/0/boom',
      'flaky/0/after',
      'confirm/0/review',
    ])
    expect(state.steps['flaky/0/boom'].error).toEqual({
      code: 'TEAPOT',
      message: 'fails on purpose',
      status: 418,
    })
    expect(state.steps['greet/1/say'].summary).toBe('Said **Hello, studio!**')
    expect(state.steps['confirm/0/review'].kind).toBe('form')
  })

  it('is monotonic in time', () => {
    const stamps = FINISHED_RUN.steps.flatMap((s) => [s.startedAt, s.finishedAt])
    for (const at of stamps) {
      if (at == null) continue
      expect(at).toBeGreaterThanOrEqual(FINISHED_RUN.run.startedAt)
      expect(at).toBeLessThanOrEqual(FINISHED_RUN.run.finishedAt as number)
    }
  })
})
