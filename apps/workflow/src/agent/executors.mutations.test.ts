/**
 * The six mutation executors (spec 10): every one drives the store the way a
 * click does, and every refusal reads the way the page's own copy reads.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { START_REFUSALS } from '../lib/autoStart'
import { seedFinishedRun, seedWaitingRun } from '../mocks/db'
import { FIXTURE_RUN_ID } from '../mocks/fixtures/finishedRun'
import { WAITING_RUN_ID, WAITING_STEP_KEY } from '../mocks/fixtures/waitingRun'
import { makeStore } from '../store'
import type { AppStore } from '../store'
import { runModeChanged } from '../store/runSlice'
import { REVIEW_KEY, flush, pumpUntil, resetHelloHarness, startHelloAtConfirmWaiting, trackedHelloStore } from '../test/helloHarness'
import { createExecutors } from './executors'
import type { ExecutorDeps } from './executors'

function executorsFor(store: AppStore, extra: Partial<ExecutorDeps> = {}) {
  const navigated: string[] = []
  const exec = createExecutors({ store, navigate: (to) => navigated.push(to), location: () => ({ pathname: '/' }), ...extra })
  return { exec, navigated }
}

/**
 * A `whenPersisted` whose queue is held open until `land()` — the write-ahead
 * queue with the run's last write still in flight (apps#580).
 */
function heldQueue() {
  const drained: string[] = []
  let land!: () => void
  const tail = new Promise<void>((resolve) => {
    land = resolve
  })
  const whenPersisted = (runId: string) => {
    drained.push(runId)
    return tail
  }
  return { whenPersisted, drained, land }
}

/** Whether `promise` has settled by the time the microtask/tick queue is empty. */
async function settledYet(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await flush()
  return settled
}

/** What an agent does with a waiting form: each evaluated field's default. */
function defaultsOf(snapshot: unknown): Record<string, unknown> {
  const waiting = (snapshot as { waitingOn: Array<{ inputs: { fields: Record<string, { default?: unknown }> } }> }).waitingOn[0]!
  return Object.fromEntries(Object.entries(waiting.inputs.fields).map(([name, field]) => [name, field.default ?? null]))
}

beforeEach(() => {
  seedFinishedRun()
  seedWaitingRun()
})

afterEach(() => {
  resetHelloHarness()
})

describe('workflow.start', () => {
  it('refuses bad values with the very strings the kickoff form shows, and starts nothing', async () => {
    const store = makeStore()
    const { exec, navigated } = executorsFor(store)
    const result = await exec['workflow.start']({ impl: 'hello', workflow: 'hello', inputs: { greeting: 42 } })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe('These inputs cannot start a run')
    expect(result.structuredContent!.errors).toEqual({ greeting: 'Expected a valid string value' })
    expect(store.getState().run.state).toBeNull()
    expect(navigated).toEqual([])
  })

  it('refuses a workflow nobody publishes with spec 07 vocabulary', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.start']({ impl: 'hello', workflow: 'nope', inputs: {} })
    expect(result.structuredContent!.errors).toEqual({ workflow: START_REFUSALS.noWorkflow })
  })

  it('refuses inputs that are not an object, and a missing argument by name', async () => {
    const { exec } = executorsFor(makeStore())
    expect((await exec['workflow.start']({ impl: 'hello', workflow: 'hello', inputs: 'x' })).structuredContent!.errors).toEqual({
      inputs: '`inputs` must be an object of input values',
    })
    expect(Object.keys((await exec['workflow.start']({ impl: 'hello', inputs: {} })).structuredContent!.errors as object)).toEqual(['workflow'])
  })

  it('starts a person-shaped run, navigates to it, and answers its id and first snapshot', async () => {
    const { store } = trackedHelloStore()
    const { exec, navigated } = executorsFor(store)
    const result = await exec['workflow.start']({ impl: 'hello', workflow: 'hello', inputs: { greeting: 'Hi', names: ['world'] } })
    expect(result.isError).toBeUndefined()
    const { runId, snapshot } = result.structuredContent as { runId: string; snapshot: { runId: string; status: string } }
    expect(runId).toMatch(/^run_/)
    expect(snapshot.runId).toBe(runId)
    expect(snapshot.status).toBe('running')
    expect(navigated).toEqual([`/hello/hello/runs/${runId}`])
    const state = store.getState().run.state!
    expect(state.runId).toBe(runId)
    expect(state.headless).toBe(false)
    expect(state.unattended).toBe(false)
    // An omitted input takes its declared default, exactly as the form's initial state does.
    expect(state.inputs).toMatchObject({ greeting: 'Hi', names: ['world'] })
    expect(result.content[0]!.text).toMatch(/^Started Hello workflow: Run run_/)
  })
})

describe('workflow.await', () => {
  it('resolves at once when the run already needs input', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const { exec } = executorsFor(store)
    const result = await exec['workflow.await']({ until: 'waiting' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ waitingOn: [{ key: REVIEW_KEY, kind: 'form' }] })
  })

  it('times out with the snapshot it got to', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const { exec } = executorsFor(store)
    const result = await exec['workflow.await']({ until: 'terminal', timeoutMs: 10 })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ timedOut: true, snapshot: { status: 'running' } })
    expect(result.content[0]!.text).toMatch(/^Timed out after 10 ms waiting for terminal; Run run_/)
  })

  it('follows the driven run off the store until it ends', async () => {
    const { store, advance } = await startHelloAtConfirmWaiting()
    const { exec } = executorsFor(store)
    const pending = exec['workflow.await']({ until: 'terminal', timeoutMs: 30_000 })
    const status = await exec['workflow.status']({})
    const submitted = await exec['workflow.submitStep']({ step: REVIEW_KEY, values: defaultsOf(status.structuredContent) })
    expect(submitted.isError).toBeUndefined()
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ status: 'succeeded' })
  })

  it('polls the record for a run this tab does not drive', async () => {
    const { exec } = executorsFor(makeStore(), { pollMs: 5 })
    const result = await exec['workflow.await']({ runId: WAITING_RUN_ID, until: 'waiting', timeoutMs: 2_000 })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ runId: WAITING_RUN_ID, waitingOn: [{ key: WAITING_STEP_KEY }] })
  })

  it('refuses an unknown `until`', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.await']({ until: 'later' })
    expect(Object.keys(result.structuredContent!.errors as object)).toEqual(['until'])
  })

  // The store runs a beat ahead of the record (apps#580): the answer waits
  // for the run's write-ahead queue, whichever path made the condition true.
  it('holds a terminal answer until the sealing write settles', async () => {
    const { store, advance } = await startHelloAtConfirmWaiting()
    const queue = heldQueue()
    const { exec } = executorsFor(store, { whenPersisted: queue.whenPersisted })
    const pending = exec['workflow.await']({ until: 'terminal', timeoutMs: 30_000 })
    const status = await exec['workflow.status']({})
    await exec['workflow.submitStep']({ step: REVIEW_KEY, values: defaultsOf(status.structuredContent) })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')
    const runId = store.getState().run.state!.runId

    // The snapshot is terminal, the seal is still queued: no answer yet.
    expect(await settledYet(pending)).toBe(false)
    expect(queue.drained).toEqual([runId])

    queue.land()
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ runId, status: 'succeeded' })
  })

  it('drains the queue on the fast path too — a run already waiting on the first read', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const queue = heldQueue()
    const { exec } = executorsFor(store, { whenPersisted: queue.whenPersisted })
    const pending = exec['workflow.await']({ until: 'waiting' })
    expect(await settledYet(pending)).toBe(false)
    expect(queue.drained).toEqual([store.getState().run.state!.runId])

    queue.land()
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ waitingOn: [{ key: REVIEW_KEY, kind: 'form' }] })
  })

  it('does not wait for the queue on a timeout — it answers with the snapshot it reached', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const queue = heldQueue()
    const { exec } = executorsFor(store, { whenPersisted: queue.whenPersisted })
    const result = await exec['workflow.await']({ until: 'terminal', timeoutMs: 10 })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ timedOut: true, snapshot: { status: 'running' } })
    expect(queue.drained).toEqual([])
  })
})

describe('workflow.submitStep', () => {
  it('completes the waiting form with the same validator a person gets, and answers the new snapshot', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const { exec } = executorsFor(store)
    const status = await exec['workflow.status']({})
    const result = await exec['workflow.submitStep']({ step: REVIEW_KEY, values: defaultsOf(status.structuredContent) })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ step: REVIEW_KEY, snapshot: { steps: { [REVIEW_KEY]: 'succeeded' } } })
    expect(result.content[0]!.text).toMatch(new RegExp(`^Submitted ${REVIEW_KEY}; Run run_`))
  })

  it('refuses bad values by field, a wrong run, and a page with no run', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const { exec } = executorsFor(store)
    const bad = await exec['workflow.submitStep']({ step: REVIEW_KEY, values: { approved: 'nope' } })
    expect(bad.isError).toBe(true)
    expect(Object.keys(bad.structuredContent!.errors as object)).toEqual(['approved'])
    expect(bad.content[0]!.text).toBe(`Could not submit ${REVIEW_KEY}`)

    const other = await exec['workflow.submitStep']({ runId: 'run_other', step: REVIEW_KEY, values: {} })
    expect(other.structuredContent!.errors).toEqual({ runId: 'This page is not driving that run — workflow.resume it first' })

    const none = await executorsFor(makeStore()).exec['workflow.submitStep']({ step: REVIEW_KEY, values: {} })
    expect(none.structuredContent!.errors).toEqual({ runId: 'No run is on this page — pass runId' })

    store.dispatch(runModeChanged('readonly'))
    const readonly = await exec['workflow.submitStep']({ step: REVIEW_KEY, values: {} })
    expect(readonly.structuredContent!.errors).toEqual({ runId: 'This page is not driving that run — workflow.resume it first' })
  })
})

describe('workflow.sign', () => {
  it('exchanges an uploads-relative path for a presigned url through the files/sign rule', async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.sign']({ path: 'workflows/hello/hello/runs/run_1/poster.svg' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ path: 'workflows/hello/hello/runs/run_1/poster.svg', expiresIn: 3600 })
    expect(String(result.structuredContent!.url)).toContain('signed=mock')
  })

  it("refuses a path outside the harness prefix with the rule's own words", async () => {
    const { exec } = executorsFor(makeStore())
    const result = await exec['workflow.sign']({ path: '../etc/passwd' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent!.errors).toEqual({ path: 'path must be an uploads-relative key under workflows/ with no traversal' })
  })
})

describe('workflow.cancel', () => {
  it('cancels the run this tab drives', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const { exec } = executorsFor(store)
    const result = await exec['workflow.cancel']({})
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ status: 'cancelled', steps: { [REVIEW_KEY]: 'cancelled' } })
    const again = await exec['workflow.cancel']({})
    expect(again.structuredContent!.errors).toEqual({ runId: `Run ${store.getState().run.state!.runId} is already cancelled` })
  })

  it('refuses a run this tab does not drive', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const { exec } = executorsFor(store)
    expect((await exec['workflow.cancel']({ runId: WAITING_RUN_ID })).structuredContent!.errors).toEqual({
      runId: 'This page is not driving that run — workflow.resume it first',
    })
    store.dispatch(runModeChanged('readonly'))
    expect((await exec['workflow.cancel']({})).isError).toBe(true)
    expect((await executorsFor(makeStore()).exec['workflow.cancel']({})).structuredContent!.errors).toEqual({
      runId: 'No run is on this page — pass runId',
    })
  })
})

describe('workflow.resume', () => {
  it('takes over a running run nobody holds, navigates to it, and drives it from here', async () => {
    const { store } = trackedHelloStore()
    const { exec, navigated } = executorsFor(store)
    const result = await exec['workflow.resume']({ runId: WAITING_RUN_ID })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ runId: WAITING_RUN_ID, snapshot: { waitingOn: [{ key: WAITING_STEP_KEY, kind: 'form' }] } })
    expect(navigated).toEqual([`/hello/hello/runs/${WAITING_RUN_ID}`])
    expect(store.getState().run.mode).toBe('live')
    expect(store.getState().run.state?.runId).toBe(WAITING_RUN_ID)
    expect(result.content[0]!.text).toMatch(/^Resumed Run run_01hellowaiting/)
  })

  it('refuses a finished run and a run that does not exist', async () => {
    const { exec, navigated } = executorsFor(trackedHelloStore().store)
    const done = await exec['workflow.resume']({ runId: FIXTURE_RUN_ID })
    expect(done.structuredContent!.errors).toEqual({ runId: `Run ${FIXTURE_RUN_ID} is succeeded; only a running run can be resumed` })
    const gone = await exec['workflow.resume']({ runId: 'run_nope' })
    expect(gone.structuredContent!.errors).toEqual({ runId: 'No such run' })
    expect(Object.keys((await exec['workflow.resume']({})).structuredContent!.errors as object)).toEqual(['runId'])
    expect(navigated).toEqual([])
  })
})
