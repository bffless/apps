// @vitest-environment node
/**
 * The `run/drive` rule's two function steps (ADR-0006, apps#598), driven the
 * way the pipeline drives them: `drivePlan` before the index fetch, then the
 * `index` http_request, then `driveGate` — the same shape `reply.test.ts` uses
 * to drive `route`/`plan`/`merge`/`reply`.
 *
 * The fixture `RUN_ID` is a short readable id (`run_01TEST`), and the drive
 * rule holds `id` to the real ULID shape the page mints, so this suite carries
 * its own valid id. The two never meet: the `find` query has already filtered
 * on `request.body.id`, so the gate never compares the body's id to the row's.
 */
import { describe, expect, it } from 'vitest'
import { HELLO_INDEX, runRow } from './fixtures/index'
import { handler as driveGate, type DriveGateSteps } from './driveGate'
import { handler as drivePlan } from './drivePlan'
import type { FnRequest } from './route'

/** `run_` + 26 Crockford-base32 characters — `lib/autoStart.ts`'s `RUN_ID_PATTERN`, which the gate re-states. */
const RUN_ID = 'run_01K5Q9Z8YX7WV6T5S4R3Q2P1N0'

const req = (body: unknown): FnRequest => ({
  body,
  headers: { host: 'h.example' },
  method: 'POST',
  path: '/public/o/r/alias/workflow/dist/api/workflow/run/drive',
})
/** What `data_query` answers for one found run row (columns under `fields`, the envelope `rows.ts` tolerates). */
const found = (row: Record<string, unknown>) => [{ id: 'rec', fields: row }]
/** What an `http_request` step answers. */
const index = (body: unknown, status = 200) => ({ ok: status < 400, status, body })

const DRIVER = { repo: 'bffless/workflow-implementations' }
const WITH_DRIVER = { ...HELLO_INDEX, driver: DRIVER }

describe('drivePlan', () => {
  it('plans the index fetch from the body (run) or the row (resume)', () => {
    const p = drivePlan({ request: req({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: {} }), steps: { find: [] } })
    expect(p).toMatchObject({ hasIndex: true, indexPath: '/w/hello/.bffless/workflows/index.json', impl: 'hello' })
    const r = drivePlan({ request: req({ id: RUN_ID, mode: 'resume' }), steps: { find: found(runRow()) } })
    expect(r).toMatchObject({ hasIndex: true, impl: 'hello' })
    expect(drivePlan({ request: req({ id: RUN_ID, mode: 'resume' }), steps: { find: [] } })).toMatchObject({ hasIndex: false })
  })

  it('reaches the implementation in-process at the request’s own base path, and reports the public origin', () => {
    const p = drivePlan({ request: req({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: {} }), steps: { find: [] } })
    expect(p.indexUrl).toBe('http://localhost:3000/public/o/r/alias/workflow/dist/w/hello/.bffless/workflows/index.json')
    expect(p).toMatchObject({ host: 'h.example', appOrigin: 'https://h.example', mode: 'run', runId: RUN_ID })
  })

  it('survives the empty call CE makes of every bundle (no request, no steps)', () => {
    expect(drivePlan({})).toMatchObject({ hasIndex: false, impl: '', indexUrl: '', appOrigin: '' })
  })
})

describe('the gate', () => {
  const gate = (body: unknown, find: unknown, idx: DriveGateSteps['index']) =>
    driveGate({ request: req(body), steps: { find, plan: drivePlan({ request: req(body), steps: { find } }), index: idx } })

  it('refuses RUN_NOT_FOUND, RUN_EXISTS, RUN_TERMINAL, LEASE_LIVE, NO_DRIVER, BAD_REQUEST', () => {
    expect(gate({ id: RUN_ID, mode: 'resume' }, [], index(HELLO_INDEX)).code).toBe('RUN_NOT_FOUND')
    expect(gate({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: {} }, found(runRow()), index(HELLO_INDEX)).code).toBe('RUN_EXISTS')
    expect(gate({ id: RUN_ID, mode: 'resume' }, found(runRow({ status: 'succeeded' })), index(HELLO_INDEX)).code).toBe('RUN_TERMINAL')
    expect(gate({ id: RUN_ID, mode: 'resume' }, found(runRow({ leaseOwner: 'tab_x', leaseUntil: Date.now() + 60_000 })), index(HELLO_INDEX)).code).toBe('LEASE_LIVE')
    expect(gate({ id: RUN_ID, mode: 'resume' }, found(runRow()), index(HELLO_INDEX)).code).toBe('NO_DRIVER')
    expect(gate({ id: 'nope', mode: 'run' }, [], index(HELLO_INDEX)).code).toBe('BAD_REQUEST')
  })

  it('refuses every malformed body before it reads a row', () => {
    const bad = (body: unknown) => gate(body, found(runRow()), index(WITH_DRIVER))
    expect(bad({ id: RUN_ID, mode: 'drive' }).code).toBe('BAD_REQUEST')
    expect(bad({ id: RUN_ID, mode: 'run', workflow: 'driven', inputs: {} }).code).toBe('BAD_REQUEST')
    expect(bad({ id: RUN_ID, mode: 'run', impl: 'hello', inputs: {} }).code).toBe('BAD_REQUEST')
    expect(bad({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: 'x' }).code).toBe('BAD_REQUEST')
    expect(bad(undefined).code).toBe('BAD_REQUEST')
    // Every refusal is a 400 the rule's one `refuse` step answers, and none dispatches.
    for (const body of [{ id: 'nope' }, { id: RUN_ID, mode: 'drive' }]) {
      expect(bad(body)).toMatchObject({ dispatch: false, refused: true, status: 400, owner: '', repo: '' })
      expect(JSON.parse(bad(body).response)).toMatchObject({ code: 'BAD_REQUEST' })
    }
  })

  it('treats an unfetchable index, a missing driver and a malformed repo alike (NO_DRIVER)', () => {
    const resume = (idx: DriveGateSteps['index']) => gate({ id: RUN_ID, mode: 'resume' }, found(runRow()), idx)
    expect(resume(index('not found', 404)).code).toBe('NO_DRIVER')
    expect(resume(undefined).code).toBe('NO_DRIVER')
    expect(resume(index({ ...HELLO_INDEX, driver: { repo: 'workflow-implementations' } })).code).toBe('NO_DRIVER')
    expect(resume(index({ ...HELLO_INDEX, driver: { repo: 'bffless/impls/extra' } })).code).toBe('NO_DRIVER')
    expect(resume(index({ ...HELLO_INDEX, driver: {} })).code).toBe('NO_DRIVER')
    expect(resume(index(WITH_DRIVER)).refused).toBe(false)
  })

  it('lets an expired or released lease through, and refuses a live one', () => {
    const at = (row: Record<string, unknown>) => gate({ id: RUN_ID, mode: 'resume' }, found(runRow(row)), index(WITH_DRIVER))
    expect(at({ leaseOwner: 'tab_x', leaseUntil: Date.now() - 1 }).dispatch).toBe(true)
    expect(at({ leaseOwner: null, leaseUntil: null }).dispatch).toBe(true)
    expect(at({ leaseOwner: 'tab_x', leaseUntil: Date.now() + 60_000 })).toMatchObject({ dispatch: false, refused: true, code: 'LEASE_LIVE' })
  })

  it('dispatches with the client_payload the Actions file reads', () => {
    const idx = index(WITH_DRIVER)
    const g = gate({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: { note: 'x' } }, [], idx)
    expect(g).toMatchObject({
      dispatch: true,
      refused: false,
      owner: 'bffless',
      repo: 'workflow-implementations',
      eventType: 'workflow-drive',
      payload: { mode: 'run', run_id: RUN_ID, harness_url: 'https://h.example', workflow: 'hello/driven', inputs: { note: 'x' } },
    })
    expect(JSON.parse(g.response)).toEqual({ dispatched: true, runId: RUN_ID, repo: 'bffless/workflow-implementations', eventType: 'workflow-drive' })
  })

  it('sends resume the run id alone — no workflow, no inputs', () => {
    const g = gate({ id: RUN_ID, mode: 'resume' }, found(runRow()), index(WITH_DRIVER))
    expect(g.payload).toEqual({ mode: 'resume', run_id: RUN_ID, harness_url: 'https://h.example' })
    expect(g).toMatchObject({ dispatch: true, owner: 'bffless', repo: 'workflow-implementations' })
  })

  it('refuses a request that carries no host — the driver would have no harness to call back', () => {
    const body = { id: RUN_ID, mode: 'resume' }
    const request: FnRequest = { body, headers: {}, method: 'POST', path: '/api/workflow/run/drive' }
    const plan = drivePlan({ request, steps: { find: found(runRow()) } })
    const g = driveGate({ request, steps: { find: found(runRow()), plan, index: index(WITH_DRIVER) } })
    expect(g).toMatchObject({ dispatch: false, refused: true, code: 'BAD_REQUEST' })
    expect(g.message).toContain('harness')
  })

  it('survives the empty call CE makes of every bundle', () => {
    expect(driveGate({})).toMatchObject({ dispatch: false, refused: true, code: 'BAD_REQUEST' })
  })
})
