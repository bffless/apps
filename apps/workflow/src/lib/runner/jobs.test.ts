import { describe, expect, it } from 'vitest'
import { replayRun } from './replay'
import { definitionOf } from '../runDefinition'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { toRunRow, toStepRow } from '../coerce'
import { itemTotal, jobDuration, jobStatus, stepsOfJob } from './jobs'

const run = toRunRow(FINISHED_RUN.run)
const def = definitionOf(run)!
const state = replayRun(run, FINISHED_RUN.steps.map(toStepRow), def)

describe('jobs', () => {
  it('lists every item of a matrix job, in item then declaration order', () => {
    expect(stepsOfJob(def, state, 'greet').map((r) => r.key)).toEqual(['greet/0/say', 'greet/1/say'])
    expect(stepsOfJob(def, state, 'greet', 1).map((r) => r.key)).toEqual(['greet/1/say'])
    expect(itemTotal(state, 'greet')).toBe(2)
    expect(itemTotal(state, 'slow')).toBe(1)
  })
  it('reads a job status as the worst of its steps', () => {
    expect(jobStatus(stepsOfJob(def, state, 'greet').map((r) => r.state!))).toBe('succeeded')
    expect(jobStatus([])).toBe('queued')
    expect(jobStatus([{ ...state.steps['slow/0/start']!, status: 'failed' }])).toBe('failed')
  })
  it('spans a job from its first start to its last finish, and is undefined while a step is still open', () => {
    const rows = stepsOfJob(def, state, 'slow').map((r) => r.state!)
    expect(jobDuration(rows)).toBe(rows[0]!.finishedAt! - rows[0]!.startedAt!)
    expect(jobDuration([{ ...rows[0]!, finishedAt: undefined }])).toBeUndefined()
  })
})
