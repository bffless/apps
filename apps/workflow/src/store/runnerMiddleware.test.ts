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
import { createRegisterFile, runnerControllers } from './runnerMiddleware'
import type { RunnerDeps } from './runnerMiddleware'
import { getOwnerId, startRun } from './runnerActions'
import { runClosed } from './runSlice'

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
}

/** A `RunStore` fake that records every write; `failUpsertKey` rejects that step's upserts forever (both attempts of the retry). */
function fakeRunStore(opts: { failUpsertKey?: StepKey } = {}): FakeRunStore {
  const writes: Recorded[] = []
  const leaseCalls: FakeRunStore['leaseCalls'] = []
  let lease: { ok: boolean; leaseUntil?: number; heldBy?: string } = { ok: true, leaseUntil: Date.now() + 60_000 }

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
      return lease
    },
  }

  return { store, writes, leaseCalls, setLease: (a) => (lease = a) }
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

    // A single big jump can outrun the heartbeat's *first* `sleep(15_000)` even
    // registering (it only does once the `run.started` listener effect has
    // actually run) — advance in small steps, same as `pumpUntil`, so the
    // heartbeat is never racing the virtual clock.
    await pumpUntil(advance, () => leaseCalls.length > 0, { stepMs: 1_000, maxSteps: 30 })

    expect(leaseCalls[0]).toEqual({ id: store.getState().run.state?.runId, owner: getOwnerId(), takeover: undefined })
    expect(store.getState().run.mode).toBe('readonly')
  })
})
