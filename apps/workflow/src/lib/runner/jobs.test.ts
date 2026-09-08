import { describe, expect, it } from 'vitest'
import { replayRun } from './replay'
import { definitionOf } from '../runDefinition'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { toRunRow, toStepRow } from '../coerce'
import type { RunState } from './types'
import { itemTotal, jobDuration, jobStatus, stepsOfJob } from './jobs'

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
    const untouched: RunState = { ...state, steps: {}, expansions: {} }
    expect(jobStatus(def, untouched, 'confirm')).toBe('queued')
  })

  it('spans a job from its first start to its last finish, and is undefined while a step is still open', () => {
    const rows = stepsOfJob(def, state, 'slow').map((r) => r.state!)
    expect(jobDuration(rows)).toBe(rows[0]!.finishedAt! - rows[0]!.startedAt!)
    expect(jobDuration([{ ...rows[0]!, finishedAt: undefined }])).toBeUndefined()
  })
})
