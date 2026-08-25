/**
 * The runner middleware (Task 17): write-ahead persistence, scheduling and the
 * lease heartbeat, driven against a real `configureStore` (`makeStore`) with
 * fake `RunnerDeps` — scenario 1 & 3 & 4 script `HttpJson`/`RunStore` fakes and
 * a manually-advanceable virtual clock (so retry/poll/heartbeat delays never
 * wait in real time); scenario 2 drives the `hello` implementation end to end
 * against the MSW mock backend, with only the clock faked.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { afterEach, describe, expect, it } from 'vitest'
import { httpJson } from '../lib/http'
import { server } from '../mocks/server'
import { loadWorkflow } from '../lib/runner/definition'
import type { Clock, HttpJson } from '../lib/runner/adapters/pipeline'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { RunStore } from '../lib/runStore'
import { createRunStore } from '../lib/runStore'
import helloYaml from '../../docs/spec/examples/hello.workflow.yaml?raw'
import type { AppStore } from './index'
import { makeStore } from './index'
import { cancelRun } from './lifecycleActions'
import { createRegisterFile, runnerControllers } from './runnerMiddleware'
import type { RunnerDeps } from './runnerMiddleware'
import { getOwnerId, startRun } from './runnerActions'
import { runClosed } from './runSlice'
import { workflowApi } from './workflowApi'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Canned = { status: number; body: unknown } | { throws: Error }

/** A scripted `HttpJson`, keyed by path — each path answers its own queue in order. */
function scriptedHttp(routes: Record<string, Canned[]>): { http: HttpJson; calls: { path: string; body?: unknown }[] } {
  const calls: { path: string; body?: unknown }[] = []
  const pending: Record<string, Canned[]> = Object.fromEntries(
    Object.entries(routes).map(([k, v]) => [k, [...v]]),
  )
  const http: HttpJson = async (path, init) => {
    calls.push({ path, body: init.body })
    const next = pending[path]?.shift()
    if (!next) throw new Error(`scriptedHttp: unexpected call to ${path}`)
    if ('throws' in next) throw next.throws
    return { status: next.status, ok: next.status >= 200 && next.status < 300, body: next.body }
  }
  return { http, calls }
}

type Recorded =
  | { op: 'create'; row: RunRow }
  | { op: 'patch'; id: string; patch: Partial<RunRow> }
  | { op: 'upsert'; runId: string; key: StepKey; patch: Partial<StepRow> }

interface FakeRunStore {
  store: RunStore
  writes: Recorded[]
  leaseCalls: { id: string; owner: string; takeover?: boolean }[]
  setLease(answer: { ok: boolean; leaseUntil?: number; heldBy?: string }): void
  /** The next `n` `lease()` calls throw (a transport failure) instead of resolving. */
  setLeaseFailures(n: number): void
}

/** A `RunStore` fake that records every write; `failUpsertKey` rejects that step's upserts forever (both attempts of the retry). */
function fakeRunStore(opts: { failUpsertKey?: StepKey } = {}): FakeRunStore {
  const writes: Recorded[] = []
  const leaseCalls: FakeRunStore['leaseCalls'] = []
  let lease: { ok: boolean; leaseUntil?: number; heldBy?: string } = { ok: true, leaseUntil: Date.now() + 60_000 }
  let leaseFailuresRemaining = 0

  const store: RunStore = {
    async createRun(row) {
      writes.push({ op: 'create', row })
    },
    async patchRun(id, patch) {
      writes.push({ op: 'patch', id, patch })
    },
    async upsertStep(runId, key, patch) {
      if (opts.failUpsertKey && key === opts.failUpsertKey) throw new Error('upsertStep: simulated failure')
      writes.push({ op: 'upsert', runId, key, patch })
    },
    async lease(id, owner, takeover) {
      leaseCalls.push({ id, owner, takeover })
      if (leaseFailuresRemaining > 0) {
        leaseFailuresRemaining -= 1
        throw new Error('lease: simulated transport failure')
      }
      return lease
    },
  }

  return {
    store,
    writes,
    leaseCalls,
    setLease: (a) => (lease = a),
    setLeaseFailures: (n) => (leaseFailuresRemaining = n),
  }
}

/** A manually-driven virtual clock: `sleep` only resolves once `advance` has moved `now` past its deadline. */
function virtualClock(start = 1_000) {
  let now = start
  interface Waiter { due: number; resolve: () => void; unlisten: () => void }
  const waiters: Waiter[] = []

  const clock: Clock = {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        const onAbort = () => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
          reject(new DOMException('aborted', 'AbortError'))
        }
        const waiter: Waiter = {
          due: now + ms,
          resolve: () => {
            waiter.unlisten()
            resolve()
          },
          unlisten: () => signal?.removeEventListener('abort', onAbort),
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      }),
  }

  /** Move `now` forward and resolve every due `sleep`, flushing real microtasks/macrotasks between rounds so resumed code can register its next wait. */
  async function advance(ms: number): Promise<void> {
    now += ms
    for (let round = 0; round < 50; round++) {
      const due = waiters.filter((w) => w.due <= now)
      if (due.length === 0) return
      for (const w of [...due]) {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        w.resolve()
      }
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  return { clock, advance }
}

/** Flush pending microtasks/macrotasks without moving the virtual clock — lets an
 *  already-dispatched cascade (e.g. `run.started`'s own listener effect registering
 *  the heartbeat's first `sleep`) settle before the clock starts moving. */
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Advance the virtual clock in small steps, flushing real ticks, until `predicate` holds. */
async function pumpUntil(
  advance: (ms: number) => Promise<void>,
  predicate: () => boolean,
  opts: { stepMs?: number; maxSteps?: number } = {},
): Promise<void> {
  const stepMs = opts.stepMs ?? 250
  for (let i = 0; i < (opts.maxSteps ?? 200); i++) {
    if (predicate()) return
    await advance(stepMs)
    await new Promise((r) => setTimeout(r, 0))
  }
  if (!predicate()) throw new Error('pumpUntil: condition never became true')
}

async function registerFileFake(): Promise<{ path: string; name: string; contentType: string; size: number; url: string }> {
  throw new Error('registerFileFake: not exercised by this scenario')
}

let stores: AppStore[] = []

function trackedStore(deps: RunnerDeps): AppStore {
  const store = makeStore(deps)
  stores.push(store)
  return store
}

afterEach(() => {
  for (const store of stores) store.dispatch(runClosed())
  runnerControllers.abortAll()
  stores = []
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------
// A tiny two-job definition: `a/0/one` (pipeline) → `b/0/ask` (form)
// ---------------------------------------------------------------------------

const TWO_JOBS = toDefinition({
  name: 'Two jobs',
  jobs: {
    a: {
      steps: [
        {
          id: 'one',
          uses: 'pipeline',
          with: { path: 'x' },
          outputs: { v: { type: 'string', value: '${{ response.v }}' } },
          summary: 'Got ${{ steps.one.outputs.v }}',
        },
      ],
      outputs: {},
    },
    b: {
      needs: 'a',
      steps: [{ id: 'ask', uses: 'form', with: { fields: { ok: { type: 'boolean', default: true } } } }],
      outputs: {},
    },
  },
  outputs: {},
}) as Definition

const ONE_KEY = stepKey('a', 0, 'one')
const ASK_KEY = stepKey('b', 0, 'ask')

// ---------------------------------------------------------------------------
// A one-job definition with top-level outputs — one that evaluates, one that
// doesn't (a malformed expression, parse error) — so the run actually
// reaches `finish` instead of stalling on a form.
// ---------------------------------------------------------------------------

const WITH_OUTPUTS = toDefinition({
  name: 'With outputs',
  jobs: {
    a: {
      steps: [
        {
          id: 'one',
          uses: 'pipeline',
          with: { path: 'x' },
          outputs: { v: { type: 'string', value: '${{ response.v }}' } },
        },
      ],
      outputs: { v: '${{ steps.one.outputs.v }}' },
    },
  },
  outputs: {
    good: '${{ jobs.a.outputs.v }}',
    // A malformed expression (dangling operator) — parse error, guaranteed
    // to throw (same pattern pipeline.test.ts uses for the same reason).
    bad: '${{ jobs.a.outputs.v == }}',
  },
}) as Definition

// ---------------------------------------------------------------------------
// A one-job definition whose step uses a kind no runner branch claims. Every
// kind the vocabulary actually has is wired now (pipeline/form in M1, island
// in Task 5, script in Task 11), so this fixture has to invent one to reach
// `handleNextAction`'s fall-through arm at all — which is exactly what that
// arm is for: a kind added to `StepKind` before the runner learns to run it
// must fail its own step, not stall the run.
// ---------------------------------------------------------------------------

const UNKNOWN_KIND_JOB = toDefinition({
  name: 'Unsupported kind',
  jobs: { a: { steps: [{ id: 'i', uses: 'sorcery', with: {} }], outputs: {} } },
  outputs: {},
}) as Definition
const UNKNOWN_KIND_KEY = stepKey('a', 0, 'i')

// ---------------------------------------------------------------------------
// A 3-item matrix, `max-parallel: 2`, fail-fast: two items run concurrently,
// one pending sibling is a fail-fast skip target for *both* if they fail
// close enough together (finding 3's race window).
// ---------------------------------------------------------------------------

const MATRIX_FAIL_FAST = toDefinition({
  name: 'Matrix fail-fast',
  jobs: {
    m: {
      strategy: { matrix: { i: [1, 2, 3] }, 'max-parallel': 2 },
      steps: [{ id: 's', uses: 'pipeline', with: { path: 'x' } }],
      outputs: {},
    },
  },
  outputs: {},
}) as Definition

// ---------------------------------------------------------------------------
// Scenario 1: the recorded write sequence, in order
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — write-ahead persistence order', () => {
  it('runs.create → steps.upsert one queued → running → succeeded → ask queued → waiting, in order', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: 'hi' } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'twojobs', def: TWO_JOBS, yaml: 'name: Two jobs', workflowName: 'Two jobs', values: {} }),
    )

    await pumpUntil(advance, () => store.getState().run.state?.steps[ASK_KEY]?.status === 'waiting')

    expect(writes.map((w) => (w.op === 'upsert' ? `steps.upsert ${w.key} ${String(w.patch.status)}` : w.op))).toEqual(
      ['create', `steps.upsert ${ONE_KEY} queued`, `steps.upsert ${ONE_KEY} running`, `steps.upsert ${ONE_KEY} succeeded`, `steps.upsert ${ASK_KEY} queued`, `steps.upsert ${ASK_KEY} waiting`],
    )

    const create = writes[0]
    if (create.op !== 'create') throw new Error('expected a create write first')
    expect(create.row.runId).toBe(store.getState().run.state?.runId)
    expect(create.row.definition).toBe(TWO_JOBS.raw)

    const running = writes[2]
    if (running.op !== 'upsert') throw new Error('expected an upsert')
    expect(running.patch.inputs).toEqual({ path: 'x' })

    const succeeded = writes[3]
    if (succeeded.op !== 'upsert') throw new Error('expected an upsert')
    expect(succeeded.patch.outputs).toEqual({ v: 'hi' })
    expect(succeeded.patch.summary).toBe('Got hi')
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: hello, end to end, against the MSW mock backend
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — hello, end to end (MSW)', () => {
  it('fans greet out over two names, retries slow once, tolerates the flaky failure, and waits on the form', async () => {
    const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition
    const { clock, advance } = virtualClock()
    const runStore = createRunStore(httpJson)
    const deps: RunnerDeps = { http: httpJson, clock, runStore, registerFile: createRegisterFile(httpJson) }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({
        impl: 'hello',
        workflow: 'hello',
        def: hello,
        yaml: helloYaml,
        workflowName: 'Hello workflow',
        values: { greeting: 'Hello', names: ['world', 'studio'], photo: null, shout: false },
      }),
    )

    await pumpUntil(advance, () => store.getState().run.state?.steps['confirm/0/review']?.status === 'waiting')

    const state = store.getState().run.state!
    expect(state.expansions.greet?.total).toBe(2)
    expect(state.steps['greet/0/say']?.status).toBe('succeeded')
    expect(state.steps['greet/1/say']?.status).toBe('succeeded')

    const slow = state.steps['slow/0/start']!
    expect(slow.status).toBe('succeeded')
    expect(slow.attempt).toBe(2) // one BUSY, one retry
    expect(slow.error).toEqual({ code: 'BUSY', message: 'the hello service is busy', status: 503 })

    expect(state.steps['flaky/0/boom']?.status).toBe('failed')
    expect(state.steps['flaky/0/after']?.status).toBe('succeeded')

    expect(state.steps['confirm/0/review']?.status).toBe('waiting')
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Scenario 3: a write-ahead failure parks the run
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — write-ahead failure', () => {
  it('parks the run on runPaused after two rejections, and schedules nothing further', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: 'hi' } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes } = fakeRunStore({ failUpsertKey: ONE_KEY })
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'twojobs', def: TWO_JOBS, yaml: 'name: Two jobs', workflowName: 'Two jobs', values: {} }),
    )

    await pumpUntil(advance, () => store.getState().run.paused !== undefined)

    expect(store.getState().run.paused).toContain(ONE_KEY)
    // `one`'s own adapter run (already launched, fire-and-forget) is free to
    // reach its own terminal event over the fake's instantly-resolving HTTP —
    // write-ahead is about the *scheduler*, not about halting an in-flight
    // adapter mid-flight. What must never happen is `b/0/ask` getting a look-in
    // and every `a/0/one` write landing durably — neither ever does, because
    // `upsertStep` for that key rejects unconditionally (queued/started/
    // succeeded all fail their own write, each independently gating its own
    // schedule step).
    expect(store.getState().run.state?.steps[ASK_KEY]).toBeUndefined()
    expect(writes).toEqual([{ op: 'create', row: expect.anything() }])
    // `abortAll()` fires synchronously in the same block that sets `paused`,
    // before the step's own fire-and-forget adapter run has any chance to
    // matter — the controller ONE_KEY was registered under is gone either way.
    expect(runnerControllers.has(ONE_KEY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: heartbeat lease and takeover
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — heartbeat', () => {
  it('leases every 15 s, and flips the mode readonly when the lease is lost', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: 'hi' } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, leaseCalls, setLease } = fakeRunStore()
    setLease({ ok: false, heldBy: 'tab_other' })
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'twojobs', def: TWO_JOBS, yaml: 'name: Two jobs', workflowName: 'Two jobs', values: {} }),
    )

    // TWO_JOBS's own progression (`a/0/one` succeeding, `b/0/ask` reaching
    // `waiting`) needs no clock advance at all — it is pure microtask-driven
    // dispatch. Settle it (and, with it, `run.started`'s own listener effect
    // registering the heartbeat's first `sleep(15_000)`) *before* the virtual
    // clock moves at all, so that `sleep` is registered at the pristine start
    // value and its due time is exactly pinned.
    const startedAt = clock.now()
    await flush()

    // Advance in small steps, same as `pumpUntil`, so the heartbeat is never
    // racing the virtual clock (a single big jump can land past the point
    // `sleep`'s resolution needs to be observed and re-register the next one).
    await pumpUntil(advance, () => leaseCalls.length > 0, { stepMs: 1_000, maxSteps: 30 })

    expect(leaseCalls[0]).toEqual({ id: store.getState().run.state?.runId, owner: getOwnerId(), takeover: undefined })
    // Pins the 15 s period (05): the first lease call lands exactly one
    // heartbeat interval after the run started, not sooner or later.
    expect(clock.now()).toBe(startedAt + 15_000)
    expect(store.getState().run.mode).toBe('readonly')
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: 'finish' — top-level outputs, the final row write, heartbeat stop
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — finish', () => {
  it('evaluates top-level outputs (errors → null + annotation), writes the final patch once, and stops the heartbeat', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: 'hi' } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes, leaseCalls } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({
        impl: 'test',
        workflow: 'withoutputs',
        def: WITH_OUTPUTS,
        yaml: 'name: With outputs',
        workflowName: 'With outputs',
        values: {},
      }),
    )

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const state = store.getState().run.state!
    expect(state.status).toBe('succeeded')
    // `good` reads a real job output; `bad` is a malformed expression — a
    // parse error, caught per-output (null) rather than failing `finish`.
    expect(state.outputs).toEqual({ good: 'hi', bad: null })
    expect(state.annotations).toEqual([
      expect.objectContaining({ level: 'warning', message: expect.stringContaining('bad') }),
    ])

    // The `finishing` guard: exactly one `run.finished` write ever lands,
    // never a duplicate.
    const finishedPatches = writes.filter(
      (w): w is Extract<Recorded, { op: 'patch' }> => w.op === 'patch' && w.patch.status === 'succeeded',
    )
    expect(finishedPatches).toHaveLength(1)
    expect(finishedPatches[0]!.id).toBe(state.runId)
    expect(finishedPatches[0]!.patch).toMatchObject({
      status: 'succeeded',
      outputs: { good: 'hi', bad: null },
      leaseOwner: null,
      leaseUntil: null,
    })
    expect(finishedPatches[0]!.patch.finishedAt).toEqual(expect.any(Number))

    // The output-eval failure's own annotation write, separate from the
    // run.finished write (eventToWrites: `run.annotation` → its own patch).
    const annotationPatch = writes.find(
      (w): w is Extract<Recorded, { op: 'patch' }> => w.op === 'patch' && Array.isArray(w.patch.annotations),
    )
    expect(annotationPatch?.patch.annotations).toEqual(state.annotations)

    // Heartbeat stopped: advancing well past another interval calls lease no further.
    const leaseCallsAtFinish = leaseCalls.length
    await advance(20_000)
    await flush()
    expect(leaseCalls.length).toBe(leaseCallsAtFinish)
  })
})

// ---------------------------------------------------------------------------
// Scenario 6: heartbeat ok branch — heartbeatAt on non-terminal steps
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — heartbeat (ok branch)', () => {
  it('upserts heartbeatAt for every non-terminal step on a successful lease, and leaves the run live', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: 'hi' } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes, leaseCalls } = fakeRunStore() // default lease: { ok: true }
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'twojobs', def: TWO_JOBS, yaml: 'name: Two jobs', workflowName: 'Two jobs', values: {} }),
    )

    // `b/0/ask` (a form) stays `waiting` — non-terminal — until Task 18
    // completes it, which is exactly the step the heartbeat should keep
    // fresh.
    await pumpUntil(advance, () => store.getState().run.state?.steps[ASK_KEY]?.status === 'waiting')
    await pumpUntil(advance, () => leaseCalls.length > 0, { stepMs: 1_000, maxSteps: 30 })

    const heartbeatWrite = writes.find(
      (w): w is Extract<Recorded, { op: 'upsert' }> =>
        w.op === 'upsert' && w.key === ASK_KEY && w.patch.heartbeatAt !== undefined,
    )
    expect(heartbeatWrite?.patch.heartbeatAt).toEqual(expect.any(Number))

    // `a/0/one` is already `succeeded` (terminal) by the time the heartbeat
    // fires — it must not get a heartbeatAt write.
    expect(
      writes.some((w) => w.op === 'upsert' && w.key === ONE_KEY && w.patch.heartbeatAt !== undefined),
    ).toBe(false)

    expect(store.getState().run.mode).toBe('live')
  })
})

// ---------------------------------------------------------------------------
// Scenario 6b (fix round 3, finding 1): the heartbeat survives a failed lease
// *request* — a transport failure, not a denial — and only actually demotes
// once the lease window it last knew about has passed.
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — heartbeat tolerates a transport failure', () => {
  it('keeps the run live through failed lease requests inside the lease window, and only demotes once it expires', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: 'hi' } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, leaseCalls, setLeaseFailures } = fakeRunStore()
    // Every heartbeat request from here on throws — a 502/network blip on
    // every subsequent beat, not just one.
    setLeaseFailures(Number.POSITIVE_INFINITY)
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'twojobs', def: TWO_JOBS, yaml: 'name: Two jobs', workflowName: 'Two jobs', values: {} }),
    )

    // Settle `run.started`'s own effect (registers the heartbeat's first
    // `sleep(15_000)`) before the virtual clock moves at all — same posture
    // as scenario 4.
    await flush()

    // The lease window (60 s) is 3x the heartbeat period (15 s): the first
    // three failed requests (+15 s, +30 s, +45 s) land entirely inside the
    // window this tab last knew it held, so none of them may demote the run.
    await pumpUntil(advance, () => leaseCalls.length >= 3, { stepMs: 1_000, maxSteps: 60 })
    expect(store.getState().run.mode).toBe('live')

    // The fourth failed request lands exactly as the window runs out — only
    // now is there nothing left to give the tab the benefit of the doubt.
    await pumpUntil(advance, () => store.getState().run.mode === 'readonly', { stepMs: 1_000, maxSteps: 30 })
    expect(leaseCalls.length).toBeGreaterThanOrEqual(4)
  })
})

// ---------------------------------------------------------------------------
// Scenario 6c (fix round 3, finding 2): the runner's own writes invalidate
// the RTK Query cache the Past-runs list and the run record read from —
// otherwise a page holding either open never learns a run started/finished.
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — RTK Query cache invalidation', () => {
  it('invalidates the Runs list on run.started, and Runs + the specific Run on run.finished', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: 'hi' } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)

    const listCalls: string[] = []
    const runCalls: string[] = []
    const onRequestStart = ({ request }: { request: Request }) => {
      if (request.method !== 'GET') return
      const path = new URL(request.url).pathname
      if (path === '/api/workflow/runs') listCalls.push(path)
      if (path === '/api/workflow/run') runCalls.push(path)
    }
    server.events.on('request:start', onRequestStart)

    try {
      // Subscribe both queries — an open Past-runs list and an open run
      // record — the way the real pages would, so an invalidation actually
      // triggers a refetch rather than just marking an unsubscribed entry
      // stale. `TWO_JOBS` (not `WITH_OUTPUTS`): it parks on `b/0/ask`
      // (`waiting`) rather than finishing on its own, which is what gives
      // `run.started`'s own invalidation a moment to observe distinct from
      // `run.finished`'s.
      await store.dispatch(workflowApi.endpoints.listRuns.initiate({ impl: 'test', workflow: 'twojobs' })).unwrap()
      expect(listCalls).toHaveLength(1)

      store.dispatch(
        startRun({ impl: 'test', workflow: 'twojobs', def: TWO_JOBS, yaml: 'name: Two jobs', workflowName: 'Two jobs', values: {} }),
      )
      await pumpUntil(advance, () => store.getState().run.state?.steps[ASK_KEY]?.status === 'waiting')
      await flush(30)

      // `run.started`: the runner's own `createRun` write never goes through
      // RTK Query, so without the middleware's own invalidation the
      // subscribed list would never learn this run exists.
      expect(listCalls).toHaveLength(2)

      const runId = store.getState().run.state!.runId
      await store.dispatch(workflowApi.endpoints.getRun.initiate(runId)).unwrap()
      expect(runCalls).toHaveLength(1)

      // Cancel (rather than let the form complete) is the simplest way to
      // reach `run.finished` deterministically from here — this test cares
      // about the invalidation, not the finish path.
      await store.dispatch(cancelRun())
      await flush(30)

      // `run.finished`: both the list and this run's own cache entry refetch.
      expect(listCalls).toHaveLength(3)
      expect(runCalls).toHaveLength(2)
    } finally {
      server.events.removeListener('request:start', onRequestStart)
    }
  })
})

// ---------------------------------------------------------------------------
// Scenario 7: an unsupported step kind fails fast (script, until Phase 2)
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — unsupported step kinds', () => {
  it('fails a step whose kind no branch claims, rather than stalling the run', async () => {
    // Covers a scheduler branch (`handleNextAction`'s 'start' case, the
    // fall-through arm) that otherwise has zero coverage now that every real
    // kind is wired: the run must reach a final state, with the fault on the
    // step that carries it.
    const { http } = scriptedHttp({})
    const { clock, advance } = virtualClock()
    const { store: runStore } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'script', def: UNKNOWN_KIND_JOB, yaml: 'name: Unsupported kind', workflowName: 'Unsupported kind', values: {} }),
    )

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state?.steps[UNKNOWN_KIND_KEY]
    expect(step?.status).toBe('failed')
    expect(step?.error).toEqual({ code: 'UNSUPPORTED_KIND_M1', message: 'sorcery steps arrive in M2' })
    expect(store.getState().run.state?.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// Scenario 8 (finding 3 regression): concurrent fail-fast skips never throw
// ---------------------------------------------------------------------------

describe('createRunnerMiddleware — fail-fast skip does not stall the run', () => {
  it('completes even when two concurrently-failing matrix items can both try to skip the same pending sibling', async () => {
    // `max-parallel: 2` starts items 0 and 1 together, leaving item 2
    // pending; both 0 and 1 are scripted to fail, so their two independent
    // `step.failed` events can each compute their own `nextActions` and
    // both propose skipping item 2's step before either dispatch has
    // landed — the exact nested-listener race finding 3 flagged. This is a
    // best-effort reproduction (JS's microtask ordering doesn't *guarantee*
    // the two failures interleave that closely on every run); its real
    // value is the observable property that must hold either way: the run
    // completes cleanly to a final state, never stalls, and the reducer
    // never throws an IllegalTransition out of a listener effect.
    const { http } = scriptedHttp({
      '/api/test/x': [
        { status: 500, body: { code: 'BOOM' } },
        { status: 500, body: { code: 'BOOM' } },
      ],
    })
    const { clock, advance } = virtualClock()
    const { store: runStore } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({
        impl: 'test',
        workflow: 'matrix',
        def: MATRIX_FAIL_FAST,
        yaml: 'name: Matrix fail-fast',
        workflowName: 'Matrix fail-fast',
        values: {},
      }),
    )

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const state = store.getState().run.state!
    expect(state.status).toBe('failed')
    expect(state.steps[stepKey('m', 0, 's')]?.status).toBe('failed')
    expect(state.steps[stepKey('m', 1, 's')]?.status).toBe('failed')
    expect(state.steps[stepKey('m', 2, 's')]?.status).toBe('skipped')
  })
})

// ---------------------------------------------------------------------------
// Scenario 9 (fix round 2 regression): resetRunnerState aborts, not just
// drops, a genuinely in-flight step, and a stale emit can never land on the
// run that replaced it.
// ---------------------------------------------------------------------------

// Same `a/0/one` key as TWO_JOBS — deliberately, so a stale event from this
// definition's run would land on an *existing* step of the same key in the
// run that replaces it, rather than throwing "unknown step" (the silent-
// corruption half of the finding, not just the throwing half).
const RETRY_SAME_KEY = toDefinition({
  name: 'Retryable, same key as TWO_JOBS',
  jobs: {
    a: {
      steps: [
        {
          id: 'one',
          uses: 'pipeline',
          with: { path: 'x' },
          retry: { max: 1, delay: '5s', if: "${{ error.code == 'BUSY' }}" },
        },
      ],
      outputs: {},
    },
  },
  outputs: {},
}) as Definition

describe('createRunnerMiddleware — resetRunnerState aborts genuinely in-flight work', () => {
  it('a stale emit from an abandoned, in-flight step never lands on the run that replaced it', async () => {
    const { http, calls } = scriptedHttp({
      '/api/test/x': [
        { status: 503, body: { code: 'BUSY' } }, // the abandoned run's one real attempt
        { status: 200, body: { v: 'hi' } }, // the new run's own attempt
      ],
    })
    const { clock, advance } = virtualClock()
    const { store: runStore } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({
        impl: 'test',
        workflow: 'retryable',
        def: RETRY_SAME_KEY,
        yaml: 'name: Retryable',
        workflowName: 'Retryable',
        values: {},
      }),
    )

    // Let the first attempt fail and park **genuinely in-flight** — inside
    // `clock.sleep(retry.delay)`, not yet terminal. `step.retrying` (which
    // bumps `attempt` to 2) is emitted synchronously right before the sleep
    // call, in the same tick — by the time this predicate is true, the sleep
    // is already registered.
    await pumpUntil(
      advance,
      () =>
        store.getState().run.state?.steps[ONE_KEY]?.attempt === 2 &&
        store.getState().run.state?.steps[ONE_KEY]?.status === 'queued',
    )
    expect(calls).toHaveLength(1)

    // Abandon it for a brand-new run of TWO_JOBS — same `a/0/one` key — in
    // the same tab. `startRun` dispatches `runOpened` then `run.started`
    // synchronously; let `runOpened`'s `resetRunnerState()` (and the new
    // run's own — clock-advance-free — progression) settle *before* moving
    // the virtual clock, so the abandoned run's sleep is aborted before it
    // would otherwise resolve.
    store.dispatch(
      startRun({ impl: 'test', workflow: 'twojobs', def: TWO_JOBS, yaml: 'name: Two jobs', workflowName: 'Two jobs', values: {} }),
    )
    await flush()

    const newRunId = store.getState().run.state?.runId
    expect(newRunId).toBeDefined()
    expect(store.getState().run.state?.steps[ONE_KEY]?.status).toBe('succeeded')
    expect(calls).toHaveLength(2) // the new run's own attempt already landed

    // Let the abandoned run's parked retry sleep resolve. If its controller
    // was properly aborted, the sleep rejects and the adapter cancels
    // quietly — no third HTTP call, no dispatch reaching the new run.
    await advance(5_000)
    await flush()

    expect(calls).toHaveLength(2) // the retry never actually re-fired
    const state = store.getState().run.state!
    expect(state.runId).toBe(newRunId)
    // The new run's own step, untouched by whatever the old run's adapter
    // eventually did with its (identical, but no-longer-current) key.
    expect(state.steps[ONE_KEY]?.status).toBe('succeeded')
    expect(state.steps[ONE_KEY]?.outputs).toEqual({ v: 'hi' })
  })
})
