/**
 * The pending seal (run_01M1CPTN6P47DXQDEABE8K9H8Y, 2026-08-31): the
 * record-sealing `run.finished` patch rides the tail of the run's write-ahead
 * queue, so `patchRun`'s `keepalive` (apps#539) protects it only once its
 * `fetch` has actually been called. A tab that navigates the moment the
 * status pill flips can tear the page down while the seal is still *queued*
 * behind a slower step upsert — leaving the record `running` under a
 * live-looking lease forever, with every later viewer polling a row that
 * will never change.
 *
 * These scenarios drive the real middleware (`makeStore`) with a gated fake
 * `RunStore` and assert the `pagehide` contract: a seal that has not durably
 * landed is re-issued straight through `RunStore.patchRun` (the `keepalive`
 * carrier), one that has landed is not sent twice, and a seal whose own
 * write *failed* (the run parked on `runPaused`) still gets the last-chance
 * send.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import type { HttpJson } from '../lib/runner/adapters/pipeline'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { RunStore } from '../lib/runStore'
import { flush, pumpUntil, virtualClock } from '../test/helloHarness'
import type { AppStore } from './index'
import { makeStore } from './index'
import { runnerControllers } from './runnerMiddleware'
import type { RunnerDeps } from './runnerMiddleware'
import { startRun } from './runnerActions'
import { runClosed } from './runSlice'

// ---------------------------------------------------------------------------
// Fakes (same shapes as runnerMiddleware.test.ts's, plus a write gate)
// ---------------------------------------------------------------------------

/** A scripted `HttpJson`, keyed by path — each path answers its own queue in order. */
function scriptedHttp(routes: Record<string, { status: number; body: unknown }[]>): HttpJson {
  const pending = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]))
  return async (path) => {
    const next = pending[path]?.shift()
    if (!next) throw new Error(`scriptedHttp: unexpected call to ${path}`)
    return { status: next.status, ok: next.status >= 200 && next.status < 300, body: next.body }
  }
}

type Recorded =
  | { op: 'create'; row: RunRow }
  | { op: 'patch'; id: string; patch: Partial<RunRow> }
  | { op: 'upsert'; runId: string; key: StepKey; patch: Partial<StepRow> }

interface GatedRunStore {
  store: RunStore
  writes: Recorded[]
  patches: { id: string; patch: Partial<RunRow> }[]
  /** How many `succeeded` upserts are parked at their gate right now. */
  parked(): number
  /** Let exactly one parked `succeeded` upsert through, in queue order. */
  release(): void
  /** Every `patchRun` from now on rejects (both attempts of the write retry). */
  failPatches(): void
}

/**
 * A recording `RunStore` whose *step-succeeded* upserts park at a gate until
 * `release()`d — the deterministic stand-in for the slow final upsert the
 * seal patch queues behind.
 */
function gatedRunStore(): GatedRunStore {
  const writes: Recorded[] = []
  const patches: { id: string; patch: Partial<RunRow> }[] = []
  const gates: Array<() => void> = []
  let patchesFail = false

  const store: RunStore = {
    async createRun(row) {
      writes.push({ op: 'create', row })
    },
    async patchRun(id, patch) {
      patches.push({ id, patch })
      if (patchesFail) throw new Error('patchRun: simulated failure')
      writes.push({ op: 'patch', id, patch })
    },
    async upsertStep(runId, key, patch) {
      if (patch.status === 'succeeded') {
        await new Promise<void>((resolve) => gates.push(resolve))
      }
      writes.push({ op: 'upsert', runId, key, patch })
    },
    async lease() {
      return { ok: true, leaseUntil: Date.now() + 60_000 }
    },
  }

  return {
    store,
    writes,
    patches,
    parked: () => gates.length,
    release: () => gates.shift()?.(),
    failPatches: () => {
      patchesFail = true
    },
  }
}

async function registerFileFake(): Promise<never> {
  throw new Error('registerFileFake: not exercised by this scenario')
}

let stores: AppStore[] = []

afterEach(() => {
  for (const store of stores) store.dispatch(runClosed())
  runnerControllers.abortAll()
  stores = []
  sessionStorage.clear()
})

// ---------------------------------------------------------------------------
// A 2-item matrix of instant pipeline steps: both items dispatch
// `step.succeeded` while their terminal upserts are still parked at the
// gate, so `run.finished` can be reached with a write still in the queue
// ahead of the seal.
// ---------------------------------------------------------------------------

const TWO_ITEMS = toDefinition({
  name: 'Two items',
  jobs: {
    m: {
      strategy: { matrix: { i: [1, 2] } },
      steps: [{ id: 's', uses: 'pipeline', with: { path: 'x' } }],
      outputs: {},
    },
  },
  outputs: {},
}) as Definition

const ITEM_0 = stepKey('m', 0, 's')
const ITEM_1 = stepKey('m', 1, 's')

function start(runStore: RunStore) {
  const http = scriptedHttp({
    '/api/test/x': [
      { status: 200, body: {} },
      { status: 200, body: {} },
    ],
  })
  const { clock, advance } = virtualClock()
  const deps: RunnerDeps = { http, clock, runStore, registerFile: registerFileFake }
  const store = makeStore(deps)
  stores.push(store)
  store.dispatch(
    startRun({ impl: 'test', workflow: 'items', def: TWO_ITEMS, yaml: 'name: Two items', workflowName: 'Two items', values: {} }),
  )
  return { store, advance }
}

const pagehide = () => window.dispatchEvent(new Event('pagehide'))

describe('the pending seal — pagehide re-issues a record-sealing patch that has not landed', () => {
  it('seals the record on pagehide while the seal is still queued behind a slow step upsert', async () => {
    const fake = gatedRunStore()
    const { store, advance } = start(fake.store)

    // Both items reach `succeeded` in the slice while their terminal upserts
    // park at the gate — dispatches don't wait on writes.
    await pumpUntil(advance, () => {
      const steps = store.getState().run.state?.steps
      return steps?.[ITEM_0]?.status === 'succeeded' && steps?.[ITEM_1]?.status === 'succeeded'
    })
    await pumpUntil(advance, () => fake.parked() > 0)

    // One terminal upsert lands; its effect sees the whole run terminal and
    // dispatches `run.finished`. The *other* item's upsert stays parked, so
    // the seal patch is queued behind it — exactly the walk's window.
    fake.release()
    await pumpUntil(advance, () => store.getState().run.state?.status === 'succeeded')
    await flush()
    expect(fake.writes.some((w) => w.op === 'patch')).toBe(false)

    // The tab navigates: `pagehide` is the last chance to start a keepalive
    // send. The seal must go out through `patchRun` directly, queue or no queue.
    pagehide()
    await flush()

    const seal = fake.patches.at(-1)
    expect(seal, 'pagehide must re-issue the record-sealing patch').toBeDefined()
    expect(seal!.id).toBe(store.getState().run.state?.runId)
    expect(seal!.patch.status).toBe('succeeded')
    expect(seal!.patch.leaseOwner).toBeNull()
    expect(seal!.patch.leaseUntil).toBeNull()
    expect(typeof seal!.patch.finishedAt).toBe('number')
  })

  it('does not re-send a seal that already landed', async () => {
    const fake = gatedRunStore()
    const { store, advance } = start(fake.store)

    await pumpUntil(advance, () => fake.parked() > 0)
    fake.release()
    await pumpUntil(advance, () => fake.parked() > 0)
    fake.release()
    await pumpUntil(advance, () => fake.writes.some((w) => w.op === 'patch'))
    await flush()

    expect(store.getState().run.state?.status).toBe('succeeded')
    const sent = fake.patches.length
    pagehide()
    await flush()
    expect(fake.patches.length).toBe(sent)
  })

  it('still offers the last-chance send when the seal write itself failed and parked the run', async () => {
    const fake = gatedRunStore()
    fake.failPatches()
    const { store, advance } = start(fake.store)

    await pumpUntil(advance, () => fake.parked() > 0)
    fake.release()
    await pumpUntil(advance, () => fake.parked() > 0)
    fake.release()
    // The seal write fails both attempts of the retry and parks the run.
    await pumpUntil(advance, () => store.getState().run.paused !== undefined)
    const attempted = fake.patches.length
    expect(attempted).toBeGreaterThanOrEqual(2) // persistWrite's own attempt + retry

    pagehide()
    await flush()
    expect(fake.patches.length).toBe(attempted + 1)
  })
})
