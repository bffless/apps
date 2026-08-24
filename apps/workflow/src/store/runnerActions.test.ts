/**
 * `startRun` (Phase 3): opens the run slice and fires the first event on a
 * real store, with no middleware wired yet (Task 17 owns persistence and
 * scheduling — this thunk only starts the run in memory).
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it } from 'vitest'
import { FINISHED_RUN } from '../mocks/fixtures/finishedRun'
import { makeStore } from './index'
import { getOwnerId, startRun } from './runnerActions'

const def = toDefinition(FINISHED_RUN.run.definition)

const VALUES = { greeting: 'Hello', names: ['world'], shout: false, photo: null }

describe('startRun', () => {
  it('opens the run, fires run.started, and returns the new run id', () => {
    const store = makeStore()

    const runId = store.dispatch(
      startRun({
        impl: 'hello',
        workflow: 'hello',
        def,
        yaml: FINISHED_RUN.run.yaml,
        workflowName: 'Hello workflow',
        values: VALUES,
      }),
    )

    expect(runId).toMatch(/^run_/)

    const run = store.getState().run
    expect(run.meta?.def).toBe(def)
    expect(run.meta?.workflowName).toBe('Hello workflow')
    expect(run.state?.status).toBe('running')
    expect(run.state?.runId).toBe(runId)
    expect(run.state?.impl).toBe('hello')
    expect(run.state?.workflow).toBe('hello')
    expect(run.state?.inputs).toEqual(VALUES)
    expect(run.mode).toBe('live')
  })

  it('carries the workflow version when the caller has one', () => {
    const store = makeStore()
    store.dispatch(
      startRun({
        impl: 'hello',
        workflow: 'hello',
        def,
        yaml: FINISHED_RUN.run.yaml,
        workflowName: 'Hello workflow',
        workflowVersion: '1.4.0',
        values: VALUES,
      }),
    )
    expect(store.getState().run.meta?.workflowVersion).toBe('1.4.0')
  })

  it('mints a fresh run id on every call', () => {
    const store = makeStore()
    const a = store.dispatch(
      startRun({ impl: 'hello', workflow: 'hello', def, yaml: '', workflowName: 'Hello', values: {} }),
    )
    const b = store.dispatch(
      startRun({ impl: 'hello', workflow: 'hello', def, yaml: '', workflowName: 'Hello', values: {} }),
    )
    expect(a).not.toBe(b)
  })
})

describe('getOwnerId', () => {
  it('memoizes one id per tab in sessionStorage', () => {
    sessionStorage.clear()
    const a = getOwnerId()
    const b = getOwnerId()
    expect(a).toBe(b)
    expect(a).toMatch(/^tab_/)
  })

  it('is stable across separate calls even after other session state changes', () => {
    sessionStorage.clear()
    const a = getOwnerId()
    sessionStorage.setItem('unrelated', 'x')
    const b = getOwnerId()
    expect(a).toBe(b)
  })
})
