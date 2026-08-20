/**
 * The `run` slice is a thin Redux shell over the pure engine (09): the reducer
 * itself owns no rules beyond "an event before `run.started` has nothing to fold".
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it } from 'vitest'
import { FINISHED_RUN } from '../mocks/fixtures/finishedRun'
import {
  runClosed,
  runEvent,
  runModeChanged,
  runOpened,
  runPaused,
  runReplaced,
  runSlice,
} from './runSlice'
import type { RunSliceState } from './runSlice'

const reducer = runSlice.reducer
const def = toDefinition(FINISHED_RUN.run.definition)
const meta = { def, yaml: FINISHED_RUN.run.yaml, workflowName: FINISHED_RUN.run.workflowName }
const started = {
  type: 'run.started',
  runId: 'run_1',
  impl: 'hello',
  workflow: 'hello',
  inputs: { greeting: 'Hello' },
  headless: false,
  at: 1000,
} as const

function opened(): RunSliceState {
  return reducer(undefined, runOpened({ meta }))
}

describe('runSlice', () => {
  it('starts empty', () => {
    expect(reducer(undefined, { type: 'init' })).toEqual({ meta: null, state: null, mode: null })
  })

  it('holds the meta before the first event', () => {
    const state = opened()
    expect(state.meta?.workflowName).toBe('Hello workflow')
    expect(state.state).toBeNull()
  })

  it('initialises on run.started and folds every later event', () => {
    let state = reducer(opened(), runEvent(started))
    expect(state.state?.runId).toBe('run_1')
    expect(state.state?.status).toBe('running')
    expect(state.mode).toBe('live')

    state = reducer(
      state,
      runEvent({ type: 'step.queued', key: 'greet/0/say', job: 'greet', index: 0, stepId: 'say', kind: 'pipeline', at: 1100 }),
    )
    expect(state.state?.steps['greet/0/say'].status).toBe('queued')
  })

  it('ignores an event that arrives before the run started', () => {
    const state = reducer(opened(), runEvent({ type: 'step.waiting', key: 'greet/0/say', at: 1 }))
    expect(state.state).toBeNull()
  })

  it('adopts a replayed state read-only, and can be switched live', () => {
    const live = reducer(opened(), runEvent(started)).state!
    let state = reducer(opened(), runReplaced({ state: live, mode: 'readonly' }))
    expect(state.mode).toBe('readonly')
    expect(state.state?.runId).toBe('run_1')

    state = reducer(state, runModeChanged('live'))
    expect(state.mode).toBe('live')
  })

  it('records and clears a persistence pause', () => {
    let state = reducer(reducer(opened(), runEvent(started)), runPaused('Could not save step greet/0/say'))
    expect(state.paused).toBe('Could not save step greet/0/say')
    state = reducer(state, runPaused(undefined))
    expect(state.paused).toBeUndefined()
  })

  it('drops everything on close', () => {
    const state = reducer(reducer(opened(), runEvent(started)), runClosed())
    expect(state).toEqual({ meta: null, state: null, mode: null })
  })
})
