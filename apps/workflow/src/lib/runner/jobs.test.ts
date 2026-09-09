import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it } from 'vitest'
import { replayRun } from './replay'
import { definitionOf } from '../runDefinition'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { toRunRow, toStepRow } from '../coerce'
import type { Definition, RunState } from './types'
import { itemTotal, itemsDone, jobDuration, jobStatus, stepsOfJob } from './jobs'

const run = toRunRow(FINISHED_RUN.run)
const def = definitionOf(run)!
const state = replayRun(run, FINISHED_RUN.steps.map(toStepRow), def)

/** `state` with one step's row overridden — for scenarios the fixture itself never reaches. */
function withStep(patch: Record<string, Partial<RunState['steps'][string]>>): RunState {
  const steps = { ...state.steps }
  for (const [key, partial] of Object.entries(patch)) {
    steps[key] = { ...steps[key]!, ...partial }
  }
  return { ...state, steps }
}

/**
 * Rows the engine never wrote simply do not exist — which is exactly what a
 * cancel leaves behind (`cancelRun` marks the rows there are; the scheduler
 * proposes no more once the run is not `running`, and a reload replays the
 * same gap).
 */
function without(base: RunState, ...keys: string[]): RunState {
  const steps = { ...base.steps }
  for (const key of keys) delete steps[key]
  return { ...base, steps }
}

/** The same workflow with `flaky.boom` no longer tolerating failure — the flag lives in the definition, not the rows. */
const strict: Definition = (() => {
  const raw = structuredClone(def.raw) as { jobs: { flaky: { steps: Record<string, unknown>[] } } }
  delete raw.jobs.flaky.steps[0]!['continue-on-error']
  return toDefinition(raw)
})()

describe('jobs', () => {
  it('lists every item of a matrix job, in item then declaration order', () => {
    expect(stepsOfJob(def, state, 'greet').map((r) => r.key)).toEqual(['greet/0/say', 'greet/1/say'])
    expect(stepsOfJob(def, state, 'greet', 1).map((r) => r.key)).toEqual(['greet/1/say'])
    expect(itemTotal(state, 'greet')).toBe(2)
    expect(itemTotal(state, 'slow')).toBe(1)
  })

  // Task 17b: a job's status is the engine's result, not the worst of its steps.
  it('reads a job as succeeded when its only failure was absorbed by continue-on-error', () => {
    // `flaky/0/boom` failed with `continue-on-error: true`; `after` ran and succeeded.
    expect(jobStatus(def, state, 'flaky')).toBe('succeeded')
  })

  it('reads a job as failed when a step failed without continue-on-error', () => {
    const failed = withStep({ 'slow/0/start': { status: 'failed' } })
    expect(jobStatus(def, failed, 'slow')).toBe('failed')
  })

  it('reads a matrix job — and one of its items — as succeeded', () => {
    expect(jobStatus(def, state, 'greet')).toBe('succeeded')
    expect(jobStatus(def, state, 'greet', 1)).toBe('succeeded')
  })

  it('reads a job with a waiting step as waiting, not running', () => {
    const waiting = withStep({ 'confirm/0/review': { status: 'waiting' } })
    expect(jobStatus(def, waiting, 'confirm')).toBe('waiting')
  })

  it('reads a job nothing has reached yet as queued', () => {
    // "Not yet" is only meaningful while the run is still going: a job with no
    // rows in a run that *ended* is one nothing ever reached, and reads
    // `skipped` (see the cancelled-run suite below).
    const untouched: RunState = { ...state, steps: {}, expansions: {}, status: 'running' }
    expect(jobStatus(def, untouched, 'confirm')).toBe('queued')
  })

  // The `/0` route of a *plain* job is the job, not "item 0" of it: the head
  // passes no index there, so both readings must agree — and they only do once
  // `itemStatus` mirrors `jobOutcome`'s headless-skip rule.
  it('reads a headless skip as succeeded, whole job and `/0` alike', () => {
    // `confirm/0/review` is the form hello skips headlessly, standing its
    // declared outputs in for the answer a person would have given (07).
    const headless = withStep({
      'confirm/0/review': { status: 'skipped', outputs: { approved: true, report: '## Hello report' } },
    })
    expect(jobStatus(def, headless, 'confirm', 0)).toBe(jobStatus(def, headless, 'confirm'))
    expect(jobStatus(def, headless, 'confirm')).toBe('succeeded')
  })

  // `jobOutcome`'s ordering, item by item: fail-fast ends a matrix job with one
  // failed step *and* cancelled siblings, and it still reads as a failure.
  it('reads an item holding an un-absorbed failure and a cancelled sibling as failed', () => {
    const interrupted = withStep({ 'flaky/0/after': { status: 'cancelled' } })
    expect(jobStatus(strict, interrupted, 'flaky', 0)).toBe('failed')
    // The same rows under the real definition: `boom`'s failure is absorbed, so
    // only the cancel is left.
    expect(jobStatus(def, interrupted, 'flaky', 0)).toBe('cancelled')
  })

  it('counts the items whose every declared step reached a terminal row', () => {
    expect(itemsDone(def, state, 'greet')).toBe(2)
    expect(itemsDone(def, without(state, 'greet/1/say'), 'greet')).toBe(1)
    expect(itemsDone(def, withStep({ 'greet/1/say': { status: 'running' } }), 'greet')).toBe(1)
    expect(itemsDone(def, state, 'slow')).toBe(1)
  })

  it('spans a job from its first start to its last finish, and is undefined while a step is still open', () => {
    const rows = stepsOfJob(def, state, 'slow').map((r) => r.state!)
    expect(jobDuration(rows)).toBe(rows[0]!.finishedAt! - rows[0]!.startedAt!)
    expect(jobDuration([{ ...rows[0]!, finishedAt: undefined }])).toBeUndefined()
  })
})

/**
 * A cancel writes no row for the steps it never reached, so `jobResult` — which
 * calls a job `running` until every declared step of every item has one — would
 * leave a cancelled run's interrupted jobs saying Running for ever, on reload
 * too. When the run itself is over, the job reads what actually happened.
 */
describe('jobStatus on a run that ended underneath its jobs', () => {
  /** Cancelled while `flaky/0/boom` was in flight and `greet` was half fanned out. */
  const cancelled: RunState = {
    ...without(
      withStep({ 'flaky/0/boom': { status: 'cancelled' } }),
      'flaky/0/after',
      'greet/1/say',
      'confirm/0/review',
    ),
    status: 'cancelled',
  }

  it('reads an interrupted job as cancelled, not running', () => {
    expect(jobStatus(def, cancelled, 'flaky')).toBe('cancelled')
    expect(jobStatus(def, cancelled, 'flaky', 0)).toBe('cancelled')
  })

  it('reads a matrix job cancelled mid-fan-out as cancelled, its finished item still succeeded', () => {
    expect(jobStatus(def, cancelled, 'greet')).toBe('cancelled')
    expect(jobStatus(def, cancelled, 'greet', 0)).toBe('succeeded')
    // Item 1 was never reached at all — nothing was stopped, so it is skipped.
    expect(jobStatus(def, cancelled, 'greet', 1)).toBe('skipped')
  })

  it('reads a job nothing reached as skipped, not cancelled', () => {
    expect(jobStatus(def, cancelled, 'confirm')).toBe('skipped')
  })

  it('keeps an un-absorbed failure ahead of the cancel', () => {
    const failedThenCancelled: RunState = {
      ...without(state, 'flaky/0/after', 'confirm/0/review'),
      status: 'cancelled',
    }
    expect(jobStatus(strict, failedThenCancelled, 'flaky')).toBe('failed')
    // Absorbed by `continue-on-error`, the same rows read as the cancel they are.
    expect(jobStatus(def, failedThenCancelled, 'flaky')).toBe('cancelled')
  })

  it('leaves the engine’s answer alone while the run is still running', () => {
    const live: RunState = { ...without(state, 'flaky/0/after'), status: 'running' }
    expect(jobStatus(def, live, 'flaky')).toBe('running')
    // And the waiting downgrade still wins there.
    const waiting: RunState = {
      ...without(withStep({ 'confirm/0/review': { status: 'waiting' } }), 'greet/1/say'),
      status: 'running',
    }
    expect(jobStatus(def, waiting, 'confirm')).toBe('waiting')
  })
})
