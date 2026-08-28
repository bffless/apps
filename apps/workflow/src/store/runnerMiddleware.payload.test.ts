/**
 * `{"$file"}` payload offload, in the middleware (Task 12): a `step.succeeded`
 * or `run.finished` output over `PAYLOAD_BUDGET_BYTES` gets uploaded and
 * substituted with `{ $file }` on the **persisted row only** — the live slice
 * state keeps the inline value. `payload.ts` itself (offload/hydrate
 * predicates, the budget) is covered in `lib/runner/payload.test.ts`; this
 * file is the wiring: the pipeline HTTP call is faked (`scriptedHttp`, as
 * `runnerMiddleware.test.ts`'s own scenarios do), but the offload's own
 * upload is **not** faked — it goes through the real `uploadBlob` against the
 * MSW files trio, the same choice `runnerMiddleware.script.test.ts` makes for
 * a script's returned Blob, so the persisted row and `db.files` really do
 * agree.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { HttpJson } from '../lib/runner/adapters/pipeline'
import { PAYLOAD_BUDGET_BYTES } from '../lib/runner/payload'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { RunStore } from '../lib/runStore'
import { db } from '../mocks/db'
import { server } from '../mocks/server'
import { flush, pumpUntil, virtualClock } from '../test/helloHarness'
import type { AppStore } from './index'
import { makeStore } from './index'
import { runnerControllers } from './runnerMiddleware'
import type { RunnerDeps } from './runnerMiddleware'
import { newRunId } from '../lib/runner/ids'
import { startRun } from './runnerActions'
import { runClosed, runEvent, runOpened } from './runSlice'
import { workflowApi } from './workflowApi'

// ---------------------------------------------------------------------------
// Fakes — the same shapes `runnerMiddleware.test.ts` uses for its own
// scripted-HTTP / fake-RunStore scenarios.
// ---------------------------------------------------------------------------

type Canned = { status: number; body: unknown } | { throws: Error }

function scriptedHttp(routes: Record<string, Canned[]>): { http: HttpJson } {
  const pending: Record<string, Canned[]> = Object.fromEntries(
    Object.entries(routes).map(([k, v]) => [k, [...v]]),
  )
  const http: HttpJson = async (path) => {
    const next = pending[path]?.shift()
    if (!next) throw new Error(`scriptedHttp: unexpected call to ${path}`)
    if ('throws' in next) throw next.throws
    return { status: next.status, ok: next.status >= 200 && next.status < 300, body: next.body }
  }
  return { http }
}

type Recorded =
  | { op: 'create'; row: RunRow }
  | { op: 'patch'; id: string; patch: Partial<RunRow> }
  | { op: 'upsert'; runId: string; key: StepKey; patch: Partial<StepRow> }

function fakeRunStore(): {
  store: RunStore
  writes: Recorded[]
  setLease: (answer: { ok: boolean; leaseUntil?: number; heldBy?: string }) => void
} {
  const writes: Recorded[] = []
  let lease: { ok: boolean; leaseUntil?: number; heldBy?: string } = { ok: true, leaseUntil: Date.now() + 60_000 }
  const store: RunStore = {
    async createRun(row) {
      writes.push({ op: 'create', row })
    },
    async patchRun(id, patch) {
      writes.push({ op: 'patch', id, patch })
    },
    async upsertStep(runId, key, patch) {
      writes.push({ op: 'upsert', runId, key, patch })
    },
    async lease() {
      return lease
    },
  }
  return { store, writes, setLease: (a) => (lease = a) }
}

/** A promise the test controls the settlement of — used to gate a PUT/HTTP call mid-flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function registerFileFake(): Promise<{ path: string; name: string; contentType: string; size: number; url: string }> {
  throw new Error('registerFileFake: not exercised by this scenario')
}

// ---------------------------------------------------------------------------
// A one-job, one-pipeline-step definition: `outputs.big`/`outputs.small` off
// the step, and the run's own top-level `outputs.big` off the job's.
// ---------------------------------------------------------------------------

const DEF = toDefinition({
  name: 'Payload offload',
  jobs: {
    a: {
      steps: [
        {
          id: 'one',
          uses: 'pipeline',
          with: { path: 'x' },
          outputs: {
            big: { type: 'string', value: '${{ response.v }}' },
            small: { type: 'string', value: '${{ response.s }}' },
          },
        },
      ],
      outputs: { big: '${{ steps.one.outputs.big }}' },
    },
  },
  outputs: { big: '${{ jobs.a.outputs.big }}' },
}) as Definition

const ONE_KEY = stepKey('a', 0, 'one')

const BIG = 'x'.repeat(PAYLOAD_BUDGET_BYTES + 1024)
const SMALL = 'y'.repeat(10 * 1024)

// ---------------------------------------------------------------------------
// Two independent (no `needs`) single-pipeline-step jobs — `a`'s output is
// oversized (offloaded), `b`'s is a plain small value. Used to prove write
// order under a slow offload (fix round 1).
// ---------------------------------------------------------------------------

const PARALLEL_DEF = toDefinition({
  name: 'Parallel payload offload',
  jobs: {
    a: {
      steps: [{ id: 'one', uses: 'pipeline', with: { path: 'a' }, outputs: { big: { type: 'string', value: '${{ response.v }}' } } }],
      outputs: {},
    },
    b: {
      steps: [{ id: 'two', uses: 'pipeline', with: { path: 'b' }, outputs: { v: { type: 'string', value: '${{ response.v }}' } } }],
      outputs: {},
    },
  },
  outputs: {},
}) as Definition

const A_KEY = stepKey('a', 0, 'one')
const B_KEY = stepKey('b', 0, 'two')

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
})

// ---------------------------------------------------------------------------

describe('payload offload — step.succeeded', () => {
  it('offloads a >256 KB step output to {$file}, keeps the live state inline, and stores it in db.files', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: BIG, s: SMALL } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'payload', def: DEF, yaml: 'name: Payload offload', workflowName: 'Payload offload', values: {} }),
    )

    await pumpUntil(advance, () => store.getState().run.state?.steps[ONE_KEY]?.status === 'succeeded')
    const runId = store.getState().run.state!.runId

    // Live slice state stays inline — expressions must stay synchronous.
    const liveStep = store.getState().run.state!.steps[ONE_KEY]
    expect(liveStep.outputs!.big).toBe(BIG)
    expect(liveStep.outputs!.small).toBe(SMALL)

    // The persisted row got {$file} for the oversized output only.
    const succeeded = writes.find(
      (w): w is Extract<Recorded, { op: 'upsert' }> => w.op === 'upsert' && w.key === ONE_KEY && w.patch.status === 'succeeded',
    )
    expect(succeeded).toBeDefined()
    const outputs = succeeded!.patch.outputs as Record<string, unknown>
    const path = `workflows/test/payload/runs/${runId}/${ONE_KEY}/big.json`
    expect(outputs.big).toEqual({ $file: expect.objectContaining({ path }) })
    expect(outputs.small).toBe(SMALL)

    // And the bytes really landed in the mock files trio.
    const stored = db.files.get(path)
    expect(stored).toBeDefined()
    expect(stored!.contentType).toBe('application/json')
  })
})

describe('payload offload — run.finished', () => {
  it('offloads a >256 KB run-level output under runs/<id>/outputs/<name>.json', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: BIG, s: SMALL } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'payload', def: DEF, yaml: 'name: Payload offload', workflowName: 'Payload offload', values: {} }),
    )

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')
    const runId = store.getState().run.state!.runId

    // Live slice state stays inline.
    expect(store.getState().run.state!.outputs!.big).toBe(BIG)

    const patch = writes.find((w): w is Extract<Recorded, { op: 'patch' }> => w.op === 'patch' && w.id === runId)
    expect(patch).toBeDefined()
    const outputs = patch!.patch.outputs as Record<string, unknown>
    const path = `workflows/test/payload/runs/${runId}/outputs/big.json`
    expect(outputs.big).toEqual({ $file: expect.objectContaining({ path }) })

    const stored = db.files.get(path)
    expect(stored).toBeDefined()
    expect(stored!.contentType).toBe('application/json')
  })
})

describe('payload offload — a failing store pauses the run', () => {
  it('parks the run rather than writing the inline giant value or dropping it', async () => {
    server.use(http.post('/api/workflow/files/prepare', () => new HttpResponse(null, { status: 500 })))

    const { http: pipelineHttp } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: BIG, s: SMALL } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes } = fakeRunStore()
    const deps: RunnerDeps = { http: pipelineHttp, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'payload', def: DEF, yaml: 'name: Payload offload', workflowName: 'Payload offload', values: {} }),
    )

    await flush()
    await pumpUntil(advance, () => store.getState().run.paused !== undefined)

    expect(store.getState().run.paused).toBeDefined()
    // No row for `one` ever reached `succeeded` — offload failed before the
    // write was even built, so neither the inline giant value nor a $file
    // pointer was ever persisted for it.
    const succeeded = writes.find((w) => w.op === 'upsert' && w.key === ONE_KEY && w.patch.status === 'succeeded')
    expect(succeeded).toBeUndefined()
  })
})

describe('payload offload — write order under a slow offload (fix round 1)', () => {
  it("keeps a slower step's write ahead of a later, faster step's — `enqueue()` is called before the offload, not after", async () => {
    const putGate = deferred<void>()
    server.use(
      http.put('/mock-upload/*', async ({ request }) => {
        await putGate.promise
        const key = decodeURIComponent(new URL(request.url).pathname.slice('/mock-upload/'.length))
        db.files.set(key, {
          bytes: new Uint8Array(await request.arrayBuffer()),
          contentType: request.headers.get('content-type') ?? 'application/octet-stream',
        })
        return new HttpResponse(null, { status: 200 })
      }),
    )

    const bGate = deferred<{ status: number; ok: boolean; body: unknown }>()
    const http_: HttpJson = async (path) => {
      if (path === '/api/test/a') return { status: 200, ok: true, body: { v: BIG } }
      if (path === '/api/test/b') return bGate.promise
      throw new Error(`unexpected call to ${path}`)
    }

    const { clock, advance } = virtualClock()
    const { store: runStore, writes } = fakeRunStore()
    const deps: RunnerDeps = { http: http_, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'parallel', def: PARALLEL_DEF, yaml: 'name: Parallel', workflowName: 'Parallel', values: {} }),
    )

    // `a`'s oversized output succeeds; its offload starts, and the PUT is
    // gated — the run's write queue still has `a`'s task pending.
    await pumpUntil(advance, () => store.getState().run.state?.steps[A_KEY]?.status === 'succeeded')

    // Release `b` now: its event dispatches (and its listener effect calls
    // its own `enqueue()`) strictly *after* `a`'s already did.
    bGate.resolve({ status: 200, ok: true, body: { v: 'small' } })
    await pumpUntil(advance, () => store.getState().run.state?.steps[B_KEY]?.status === 'succeeded')

    // `b` has succeeded in live state, but its write cannot have executed
    // yet — it is chained behind `a`'s still-in-flight (gated) offload in
    // the run's own write queue. If the offload were awaited *before*
    // `enqueue()` (the bug), nothing would stop `b`'s offload-free write
    // from landing here already.
    expect(writes.some((w) => w.op === 'upsert' && w.key === B_KEY && w.patch.status === 'succeeded')).toBe(false)

    putGate.resolve()
    await pumpUntil(advance, () => writes.some((w) => w.op === 'upsert' && w.key === B_KEY && w.patch.status === 'succeeded'))

    const succeededOrder = writes
      .filter((w): w is Extract<Recorded, { op: 'upsert' }> => w.op === 'upsert' && w.patch.status === 'succeeded')
      .map((w) => w.key)
    expect(succeededOrder.indexOf(A_KEY)).toBeLessThan(succeededOrder.indexOf(B_KEY))
  })
})

describe('payload offload — a lease loss aborts the offload; the write is skipped, not paused (fix round 1)', () => {
  it('drops the write silently when the run stops being the one this tab drives partway through the upload', async () => {
    const putGate = deferred<void>()
    server.use(http.put('/mock-upload/*', async () => putGate.promise.then(() => new HttpResponse(null, { status: 200 }))))

    const { http: pipelineHttp } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: BIG, s: SMALL } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes, setLease } = fakeRunStore()
    const deps: RunnerDeps = { http: pipelineHttp, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    store.dispatch(
      startRun({ impl: 'test', workflow: 'payload', def: DEF, yaml: 'name: Payload offload', workflowName: 'Payload offload', values: {} }),
    )

    // `one` succeeds; its offload starts and is stuck on the gated PUT.
    await pumpUntil(advance, () => store.getState().run.state?.steps[ONE_KEY]?.status === 'succeeded')

    // The lease is lost on the next heartbeat tick — `loseLease` aborts
    // every live controller, including the step's own (reused by the
    // offload's upload).
    setLease({ ok: false, heldBy: 'tab_other' })
    await pumpUntil(advance, () => store.getState().run.mode === 'readonly', { stepMs: 1_000, maxSteps: 30 })

    expect(store.getState().run.paused).toBeUndefined()
    expect(writes.some((w) => w.op === 'upsert' && w.key === ONE_KEY && w.patch.status === 'succeeded')).toBe(false)

    // Release the gate — the mocked PUT would now happily finish, but the
    // client side already aborted the request; nothing more should land.
    putGate.resolve()
    await flush()

    expect(store.getState().run.paused).toBeUndefined()
    expect(writes.some((w) => w.op === 'upsert' && w.key === ONE_KEY && w.patch.status === 'succeeded')).toBe(false)
  })
})

describe('payload offload — a stale run.finished still runs the terminal cleanup (apps#375)', () => {
  it('invalidates the run caches (the observable half of the cleanup) when the finish offload was aborted by a lease loss', async () => {
    // PUT #1 is the step's own offload and lands; PUT #2 is the run-level
    // `outputs/big.json` and is held open until the lease is gone.
    let puts = 0
    const putGate = deferred<void>()
    server.use(
      http.put('/mock-upload/*', async () => {
        puts += 1
        if (puts > 1) await putGate.promise
        return new HttpResponse(null, { status: 200 })
      }),
    )
    let listReads = 0
    server.use(
      http.get('/api/workflow/runs', () => {
        listReads += 1
        return HttpResponse.json([])
      }),
    )

    const { http: pipelineHttp } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: BIG, s: SMALL } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes, setLease } = fakeRunStore()
    const deps: RunnerDeps = { http: pipelineHttp, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    // A subscribed Past-runs query: a `Runs` invalidation shows up as a refetch.
    const listing = store.dispatch(workflowApi.endpoints.listRuns.initiate({ impl: 'test', workflow: 'payload' }))
    await listing
    store.dispatch(
      startRun({ impl: 'test', workflow: 'payload', def: DEF, yaml: 'name: Payload offload', workflowName: 'Payload offload', values: {} }),
    )

    // The slice reaches `run.finished`; its offload is stuck on PUT #2.
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')
    await flush()
    expect(puts).toBe(2)
    const runId = store.getState().run.state!.runId
    const before = listReads

    // The lease is lost on the next heartbeat tick: `loseLease` aborts the
    // run-level offload's controller, and `writeEvent` answers `stale`.
    setLease({ ok: false, heldBy: 'tab_other' })
    await pumpUntil(advance, () => store.getState().run.mode === 'readonly', { stepMs: 1_000, maxSteps: 30 })
    putGate.resolve()
    await flush()

    // Nothing terminal was written, nothing paused — the fix round 1 contract…
    expect(store.getState().run.paused).toBeUndefined()
    expect(writes.some((w) => w.op === 'patch' && w.id === runId && w.patch.status !== undefined)).toBe(false)
    // …and the terminal cleanup still ran: the caches were invalidated.
    await pumpUntil(advance, () => listReads > before, { stepMs: 10, maxSteps: 50 })
    expect(listReads).toBeGreaterThan(before)
    listing.unsubscribe()
  })
})


// ---------------------------------------------------------------------------
// step.skipped — a `headless: skip` is the run's other output carrier
// ---------------------------------------------------------------------------

/**
 * hello's `card` → `review` pair in miniature: a pipeline step produces an
 * oversized `big`, and the form step's `headless: skip` stands
 * `${{ needs.card.outputs.big }}` in for the cover a person would have picked
 * (M3 Task 12). A skip's outputs are persisted from the same column the
 * succeeded path writes, so they must go through the same offload — otherwise
 * the giant value is inlined into the step row and the oversized record write
 * parks the run.
 */
const SKIP_DEF = toDefinition({
  name: 'Skip payload offload',
  jobs: {
    card: {
      steps: [
        {
          id: 'draw',
          uses: 'pipeline',
          with: { path: 'x' },
          outputs: {
            big: { type: 'string', value: '${{ response.v }}' },
            small: { type: 'string', value: '${{ response.s }}' },
          },
        },
      ],
      outputs: {
        big: '${{ steps.draw.outputs.big }}',
        small: '${{ steps.draw.outputs.small }}',
      },
    },
    review: {
      needs: 'card',
      steps: [
        {
          id: 'confirm',
          uses: 'form',
          with: {
            title: 'Review the card',
            fields: { big: { type: 'string' }, small: { type: 'string' } },
            submit: 'Approve',
          },
          headless: {
            mode: 'skip',
            outputs: {
              big: '${{ needs.card.outputs.big }}',
              small: '${{ needs.card.outputs.small }}',
            },
          },
        },
      ],
      outputs: {},
    },
  },
  outputs: {},
}) as Definition

const CONFIRM_KEY = stepKey('review', 0, 'confirm')

/** `startRun` still hardcodes `headless: false` (Task 13 owns that), so the run's first event is dispatched here. */
function startHeadlessRun(store: AppStore, def: Definition): void {
  store.dispatch(
    runOpened({ meta: { def, yaml: 'name: Skip payload offload', workflowName: 'Skip payload offload' } }),
  )
  store.dispatch(
    runEvent({
      type: 'run.started',
      runId: newRunId(),
      impl: 'test',
      workflow: 'payload',
      inputs: {},
      headless: true,
      at: 1_000,
    }),
  )
}

describe('payload offload — step.skipped (a headless skip)', () => {
  it('offloads a >256 KB skip output to {$file}, keeps the live state inline, and never parks the run', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: BIG, s: SMALL } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    startHeadlessRun(store, SKIP_DEF)

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')
    const runId = store.getState().run.state!.runId

    // The write never failed: an inlined giant value would have blown the
    // record budget and parked the run with a persistence banner.
    expect(store.getState().run.paused).toBeUndefined()
    expect(store.getState().run.state!.steps[CONFIRM_KEY].status).toBe('skipped')

    // Live slice state stays inline — expressions must stay synchronous.
    const liveStep = store.getState().run.state!.steps[CONFIRM_KEY]
    expect(liveStep.outputs!.big).toBe(BIG)
    expect(liveStep.outputs!.small).toBe(SMALL)

    // The persisted row got {$file} for the oversized output only, under the
    // skipped step's own scope (not the upstream step that produced the value).
    const skipped = writes.find(
      (w): w is Extract<Recorded, { op: 'upsert' }> =>
        w.op === 'upsert' && w.key === CONFIRM_KEY && w.patch.status === 'skipped',
    )
    expect(skipped).toBeDefined()
    const outputs = skipped!.patch.outputs as Record<string, unknown>
    const path = `workflows/test/payload/runs/${runId}/${CONFIRM_KEY}/big.json`
    expect(outputs.big).toEqual({ $file: expect.objectContaining({ path }) })
    expect(outputs.small).toBe(SMALL)

    // And the bytes really landed in the mock files trio.
    const stored = db.files.get(path)
    expect(stored).toBeDefined()
    expect(stored!.contentType).toBe('application/json')
  })

  it('leaves a small skip inline, offloading nothing', async () => {
    const { http } = scriptedHttp({ '/api/test/x': [{ status: 200, body: { v: SMALL, s: SMALL } }] })
    const { clock, advance } = virtualClock()
    const { store: runStore, writes } = fakeRunStore()
    const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }

    const store = trackedStore(deps)
    startHeadlessRun(store, SKIP_DEF)

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')
    const runId = store.getState().run.state!.runId

    expect(store.getState().run.paused).toBeUndefined()

    const skipped = writes.find(
      (w): w is Extract<Recorded, { op: 'upsert' }> =>
        w.op === 'upsert' && w.key === CONFIRM_KEY && w.patch.status === 'skipped',
    )
    expect(skipped!.patch.outputs).toEqual({ big: SMALL, small: SMALL })
    expect(db.files.get(`workflows/test/payload/runs/${runId}/${CONFIRM_KEY}/big.json`)).toBeUndefined()
  })
})
