/**
 * `runSnapshotOf`: `window.__workflow` plus `waitingOn`, off a live run state.
 * Driven through the real middleware to a waiting form (the hello harness)
 * and, for the island half, off a hand-built state — an island's pane is a
 * component, and this module must not need one.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { initialRunState, runReducer } from '../lib/runner/reducer'
import type { Definition, RunState } from '../lib/runner/types'
import { snapshotOf } from '../lib/workflowGlobal'
import { REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting } from '../test/helloHarness'
import { runSnapshotOf } from './snapshot'

afterEach(() => {
  resetHelloHarness()
})

const ISLAND_DEF = toDefinition({
  name: 'One island',
  jobs: {
    pick: {
      steps: [
        {
          id: 'choose',
          uses: 'island',
          with: { src: 'islands/pick-line.html', title: 'Pick', lines: ['a', 'b'] },
          outputs: { line: { type: 'string', required: true }, index: { type: 'number' } },
        },
      ],
    },
  },
}) as Definition

function islandWaiting(): RunState {
  let state = initialRunState({ runId: 'run_island', impl: 'hello', workflow: 'one', inputs: {}, headless: false, unattended: false, startedAt: 1 })
  state = runReducer(state, { type: 'step.queued', key: 'pick/0/choose', job: 'pick', index: 0, stepId: 'choose', kind: 'island', at: 2 })
  state = runReducer(state, { type: 'step.started', key: 'pick/0/choose', inputs: { lines: ['a', 'b'] }, at: 3 })
  state = runReducer(state, { type: 'step.waiting', key: 'pick/0/choose', at: 4 })
  return state
}

describe('runSnapshotOf', () => {
  it('is window.__workflow plus waitingOn', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const { meta, state } = store.getState().run
    const snapshot = runSnapshotOf(meta!.def, state!)
    expect(snapshot).toMatchObject(snapshotOf(state!))
    expect(snapshot.currentSteps).toEqual([REVIEW_KEY])
    expect(snapshot.waitingOn).toHaveLength(1)
    const [waiting] = snapshot.waitingOn
    expect(waiting!.key).toBe(REVIEW_KEY)
    expect(waiting!.kind).toBe('form')
    // A form's evaluated `with` — what the pane renders from.
    const inputs = waiting!.inputs as { fields?: Record<string, unknown>; title?: string }
    expect(typeof inputs.title).toBe('string')
    expect(Object.keys(inputs.fields ?? {}).length).toBeGreaterThan(0)
    expect(waiting!.src).toBeUndefined()
    expect(waiting!.outputs).toBeUndefined()
  })

  it('describes a waiting island: tool arguments, declared outputs, the declared src when no handle is mounted', () => {
    const snapshot = runSnapshotOf(ISLAND_DEF, islandWaiting())
    expect(snapshot.waitingOn).toEqual([
      {
        key: 'pick/0/choose',
        kind: 'island',
        inputs: { lines: ['a', 'b'] },
        outputs: { line: { type: 'string', required: true }, index: { type: 'number' } },
        src: 'islands/pick-line.html',
      },
    ])
  })

  it('a finished run waits on nothing', () => {
    let state = islandWaiting()
    state = runReducer(state, { type: 'step.succeeded', key: 'pick/0/choose', outputs: { line: 'a', index: 0 }, at: 5 })
    state = runReducer(state, { type: 'run.finished', status: 'succeeded', outputs: { line: 'a' }, at: 6 })
    const snapshot = runSnapshotOf(ISLAND_DEF, state)
    expect(snapshot.status).toBe('succeeded')
    expect(snapshot.waitingOn).toEqual([])
    expect(snapshot.outputs).toEqual({ line: 'a' })
  })
})
