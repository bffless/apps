/**
 * The shared run gate (spec 11 D26), wired into three real mock routes (Task
 * B4): `run/get`, `run/update`, `run-step/post`. `runGate.fn.parity.test.ts`
 * proves the *decision* in isolation, over a case table run against both the
 * generated `mcp-fn/runGate.fn.js` and `mockGate`; this proves the decision
 * actually reaches each endpoint's response — the way
 * `deleteGate.fn.parity.test.ts`'s "against the mock endpoint" block does for
 * delete.
 *
 * A separate file, not a `describe` inside `runGate.fn.parity.test.ts`: that
 * file opts into the `node` test environment for `runInCeSandbox` (its own
 * banner explains why — the generator's shebang), which leaves no `location`
 * for MSW to resolve the mock handlers' relative URL patterns against, so a
 * real `fetch()` there never reaches them. This file takes the suite's
 * default (jsdom) environment instead, the same one
 * `deleteGate.fn.parity.test.ts` runs in.
 *
 * The fixture run is owned by `MOCK_MEMBER` (Decision 12); `MOCK_OTHER` is a
 * member who neither started it nor asked for all-scope, so every route
 * refuses. `run/get` refuses the same way it answers an unknown id — 200
 * `{ run: null, steps: [] }`, never a 404 (Decision 4) — while `run/update`
 * and `run-step` answer 404 `{ ok:false, error:'run not found' }`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MOCK_MEMBER, MOCK_OTHER, db, seedFinishedRun, setMockUser } from './db'
import { FIXTURE_RUN_ID } from './fixtures/finishedRun'
import { DRIVE_KEY_HEADER } from './runGate'

describe('the run gate, against the mock endpoints (Task B4)', () => {
  beforeEach(() => {
    seedFinishedRun()
  })

  it('run/get: the owner sees the run', async () => {
    setMockUser(MOCK_MEMBER)

    const res = await fetch(`/api/workflow/run?id=${FIXTURE_RUN_ID}`)

    expect(res.status).toBe(200)
    const json = (await res.json()) as { run: { runId: string } | null }
    expect(json.run?.runId).toBe(FIXTURE_RUN_ID)
  })

  it('run/get: another member sees the same nothing an unknown id gets (Decision 4)', async () => {
    setMockUser(MOCK_OTHER)

    const res = await fetch(`/api/workflow/run?id=${FIXTURE_RUN_ID}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run: null, steps: [] })
  })

  it('run/update: the owner may patch', async () => {
    setMockUser(MOCK_MEMBER)

    // The fixture's own status is already 'succeeded' (finishedRun.ts) — patch
    // to something else so a passing write is actually distinguishable from a
    // no-op.
    const res = await fetch('/api/workflow/run/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: FIXTURE_RUN_ID, patch: { status: 'cancelled' } }),
    })

    expect(res.status).toBe(200)
    expect(db.runs.get(FIXTURE_RUN_ID)?.status).toBe('cancelled')
  })

  it('run/update: another member is refused, 404', async () => {
    setMockUser(MOCK_OTHER)

    const res = await fetch('/api/workflow/run/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: FIXTURE_RUN_ID, patch: { status: 'cancelled' } }),
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
    // Refused, so the write never happened — the fixture's own status stands.
    expect(db.runs.get(FIXTURE_RUN_ID)?.status).toBe('succeeded')
  })

  it('run-step: the owner may upsert a step', async () => {
    setMockUser(MOCK_MEMBER)

    const res = await fetch('/api/workflow/run-step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: FIXTURE_RUN_ID, key: 'hello/0/say', patch: { status: 'running' } }),
    })

    expect(res.status).toBe(200)
  })

  it('run-step: another member is refused, 404', async () => {
    setMockUser(MOCK_OTHER)

    const res = await fetch('/api/workflow/run-step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: FIXTURE_RUN_ID, key: 'hello/0/say', patch: { status: 'running' } }),
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
  })
})

/**
 * The driver's own contract, after the run is over (apps#665 review; spec 07
 * §Results). A dispatched run is created by the driver but *owned* by the
 * member who asked for it, so the driver's only identity is the nonce — and
 * everything it does last is a read of a **finished** run: `workflow-headless`
 * polls `run/get` for the sealed record, then downloads each `file` output
 * from the serve route. The gate's drive door therefore admits regardless of
 * status, and `run/update`'s merge no longer clears the key at the seal; this
 * pair is what keeps that true.
 *
 * The fixture is `succeeded` already (`finishedRun.ts`), which is exactly the
 * state both reads happen in. `MOCK_OTHER` stands in for the driver's own
 * session — a member who did not start the run and asked for no scope.
 */
describe('the drive nonce outlives the run it drove (apps#665)', () => {
  const KEY = 'dk_endpoints0001'

  beforeEach(() => {
    seedFinishedRun()
    db.runs.set(FIXTURE_RUN_ID, { ...db.runs.get(FIXTURE_RUN_ID)!, driveKey: KEY })
    setMockUser(MOCK_OTHER)
  })

  it('run/get: the driver reads the record it has just sealed', async () => {
    expect(db.runs.get(FIXTURE_RUN_ID)?.status).toBe('succeeded')

    const res = await fetch(`/api/workflow/run?id=${FIXTURE_RUN_ID}`, { headers: { [DRIVE_KEY_HEADER]: KEY } })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { run: { runId: string } | null }
    expect(json.run?.runId).toBe(FIXTURE_RUN_ID)
  })

  it('the serve route: the driver downloads the finished run’s file outputs', async () => {
    const key = `workflows/hello/hello/runs/${FIXTURE_RUN_ID}/poster.png`
    db.files.set(key, { bytes: new Uint8Array([7]), contentType: 'image/png' })

    // Without the nonce the driver is just another member: the same 404.
    expect((await fetch(`/api/uploads/${key}`)).status).toBe(404)

    const res = await fetch(`/api/uploads/${key}`, { headers: { [DRIVE_KEY_HEADER]: KEY } })

    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7]))
  })

  it('a nonce that is not this run’s opens nothing, terminal or not', async () => {
    const res = await fetch(`/api/workflow/run?id=${FIXTURE_RUN_ID}`, { headers: { [DRIVE_KEY_HEADER]: 'dk_wrong' } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run: null, steps: [] })
  })
})
