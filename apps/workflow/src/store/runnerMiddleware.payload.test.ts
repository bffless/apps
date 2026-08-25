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
import { startRun } from './runnerActions'
import { runClosed } from './runSlice'

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

function fakeRunStore(): { store: RunStore; writes: Recorded[] } {
  const writes: Recorded[] = []
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
      return { ok: true, leaseUntil: Date.now() + 60_000 }
    },
  }
  return { store, writes }
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
