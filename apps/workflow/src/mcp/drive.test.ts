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
import { handler as runGate, type FnUser } from './runGate'
import type { FnRequest, FnUtils } from './route'

/** `run_` + 26 Crockford-base32 characters — `lib/autoStart.ts`'s `RUN_ID_PATTERN`, which the gate re-states. */
const RUN_ID = 'run_01K5Q9Z8YX7WV6T5S4R3Q2P1N0'

/**
 * The requester. Its id is the fixture row's `startedBy` on purpose: from D26
 * the `resume` branch runs behind the shared run gate, so the caller these
 * cases drive has to be able to reach `runRow()` at all.
 */
const MEMBER: FnUser = { id: 'member@example.com', email: 'member@example.test', role: 'user', projectRole: 'contributor' }

/** Another project member — the one a claim on the same run id must refuse. */
const OTHER: FnUser = { id: 'user_other', email: 'else@example.test', role: 'user', projectRole: 'contributor' }

/**
 * CE's `utils.randomToken` (`function-runner.service.ts`): `bytes` of
 * randomness, hex-encoded. Counted rather than random so a test can say which
 * key it expects, and still `bytes * 2` hex characters wide, which is the part
 * the payload assertion rides on.
 */
let minted = 0
const UTILS: FnUtils = {
  randomToken: (bytes = 18) => {
    minted += 1
    return String(minted).padStart(bytes * 2, '0')
  },
}

/** A `workflow_run_claims` row as its `data_query` step answers it. */
const claimRow = (overrides: Record<string, unknown> = {}) => ({
  runId: RUN_ID,
  impl: 'hello',
  workflow: 'driven',
  startedBy: MEMBER.id,
  startedByEmail: MEMBER.email,
  driveKey: 'a'.repeat(48),
  createdAt: 1_756_800_000_000,
  ...overrides,
})

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
    const p = drivePlan({ request: req({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: {} }), steps: { run: [] } })
    expect(p).toMatchObject({ hasIndex: true, indexPath: '/w/hello/.bffless/workflows/index.json', impl: 'hello' })
    const r = drivePlan({ request: req({ id: RUN_ID, mode: 'resume' }), steps: { run: found(runRow()) } })
    expect(r).toMatchObject({ hasIndex: true, impl: 'hello' })
    expect(drivePlan({ request: req({ id: RUN_ID, mode: 'resume' }), steps: { run: [] } })).toMatchObject({ hasIndex: false })
  })

  it('raises isResume for the resume mode alone — the flag the runGate step is gated on', () => {
    const at = (mode: string) => drivePlan({ request: req({ id: RUN_ID, mode }), steps: { run: found(runRow()) } }).isResume
    expect(at('resume')).toBe(true)
    expect(at('run')).toBe(false)
    expect(at('drive')).toBe(false)
    expect(drivePlan({}).isResume).toBe(false)
  })

  it('reaches the implementation in-process at the request’s own base path, and reports the public origin', () => {
    const p = drivePlan({ request: req({ id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: {} }), steps: { run: [] } })
    expect(p.indexUrl).toBe('http://localhost:3000/public/o/r/alias/workflow/dist/w/hello/.bffless/workflows/index.json')
    expect(p).toMatchObject({ host: 'h.example', appOrigin: 'https://h.example', mode: 'run', runId: RUN_ID })
  })

  it('survives the empty call CE makes of every bundle (no request, no steps)', () => {
    expect(drivePlan({})).toMatchObject({ hasIndex: false, impl: '', indexUrl: '', appOrigin: '' })
  })
})

/**
 * The gate as the *rule* drives it — `run` → `claim` → `plan` → `index` →
 * `runGate` → `gate`, with the requester's identity and CE's `utils` on the
 * handler argument. `runGate` runs only when `steps.plan.isResume`, exactly as
 * the rule's `config.condition` has it, so a `run`-mode case really does reach
 * the gate with `steps.runGate` undefined.
 */
const drive = (
  body: unknown,
  opts: { run?: unknown; claim?: unknown; index?: DriveGateSteps['index']; user?: FnUser; utils?: FnUtils } = {},
) => {
  const request = req(body)
  const run = opts.run ?? []
  const user = 'user' in opts ? opts.user : MEMBER
  const plan = drivePlan({ request, steps: { run } })
  const steps: DriveGateSteps = { run, claim: opts.claim ?? [], plan, index: opts.index }
  if (plan.isResume) steps.runGate = runGate({ steps: { run }, request, user })
  return driveGate({ request, steps, user, utils: 'utils' in opts ? opts.utils : UTILS })
}

describe('the gate', () => {
  const gate = (body: unknown, run: unknown, idx: DriveGateSteps['index']) => drive(body, { run, index: idx })

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
      payload: {
        mode: 'run',
        run_id: RUN_ID,
        harness_url: 'https://h.example',
        workflow: 'hello/driven',
        inputs: { note: 'x' },
        // The nonce the driver injects as `x-workflow-drive-key` on every
        // request its browser makes (D28) — `utils.randomToken(24)`, hex.
        drive_key: expect.stringMatching(/^[0-9a-f]{48}$/),
      },
    })
    expect(JSON.parse(g.response)).toEqual({ dispatched: true, runId: RUN_ID, repo: 'bffless/workflow-implementations', eventType: 'workflow-drive' })
  })

  it('sends resume the run id alone — no workflow, no inputs', () => {
    const g = gate({ id: RUN_ID, mode: 'resume' }, found(runRow()), index(WITH_DRIVER))
    expect(g.payload).toEqual({ mode: 'resume', run_id: RUN_ID, harness_url: 'https://h.example', drive_key: g.driveKey })
    expect(g).toMatchObject({ dispatch: true, owner: 'bffless', repo: 'workflow-implementations' })
  })

  it('refuses a request that carries no host — the driver would have no harness to call back', () => {
    const body = { id: RUN_ID, mode: 'resume' }
    const request: FnRequest = { body, headers: {}, method: 'POST', path: '/api/workflow/run/drive' }
    const plan = drivePlan({ request, steps: { run: found(runRow()) } })
    const g = driveGate({ request, steps: { run: found(runRow()), plan, index: index(WITH_DRIVER) }, user: MEMBER, utils: UTILS })
    expect(g).toMatchObject({ dispatch: false, refused: true, code: 'BAD_REQUEST' })
    expect(g.message).toContain('harness')
  })

  it('survives the empty call CE makes of every bundle', () => {
    expect(driveGate({})).toMatchObject({ dispatch: false, refused: true, code: 'BAD_REQUEST' })
  })
})

/**
 * Attribution (spec 11 §Attribution, D28). A driven run is created by the
 * DRIVER's identity inside the browser it opens, so `run/drive` — the last
 * point in the chain where the requester's credential exists — writes the
 * claim that says whose run it really is, and hands the driver the nonce that
 * redeems it at `runs/post`.
 */
describe('the claim', () => {
  const RUN = { id: RUN_ID, mode: 'run', impl: 'hello', workflow: 'driven', inputs: { note: 'x' } }
  const idx = () => index(WITH_DRIVER)

  it('is written for the requester, with a 48-hex nonce that also rides the payload', () => {
    const g = drive(RUN, { index: idx() })

    expect(g).toMatchObject({ dispatch: true, writeClaim: true, rekey: false, recordId: '' })
    expect(g.driveKey).toMatch(/^[0-9a-f]{48}$/)
    expect(g.claim).toMatchObject({
      runId: RUN_ID,
      impl: 'hello',
      workflow: 'driven',
      startedBy: MEMBER.id,
      startedByEmail: MEMBER.email,
      driveKey: g.driveKey,
    })
    expect(typeof g.claim!.createdAt).toBe('number')
    expect(g.payload.drive_key).toBe(g.driveKey)
    // The 202 is a receipt, never a key delivery: the nonce reaches the driver
    // through `client_payload` alone, and the caller never sees it.
    expect(g.response).not.toContain(g.driveKey)
    expect(JSON.parse(g.response)).toEqual({ dispatched: true, runId: RUN_ID, repo: 'bffless/workflow-implementations', eventType: 'workflow-drive' })
  })

  it('is reused by the same requester — a retry after a failed dispatch writes no second row', () => {
    const g = drive(RUN, { claim: found(claimRow()), index: idx() })

    expect(g).toMatchObject({ dispatch: true, writeClaim: false, driveKey: 'a'.repeat(48) })
    expect(g.payload.drive_key).toBe('a'.repeat(48))
    expect(g.claim).toMatchObject({ startedBy: MEMBER.id, driveKey: 'a'.repeat(48) })
  })

  it('refuses a run id another member has just claimed', () => {
    const theirs = { startedBy: OTHER.id, startedByEmail: OTHER.email, createdAt: Date.now() }
    const g = drive(RUN, { claim: found(claimRow(theirs)), index: idx() })

    expect(g).toMatchObject({ dispatch: false, refused: true, code: 'RUN_EXISTS', status: 400, writeClaim: false, driveKey: '' })
    expect(g.message).toContain('another member')
    expect(g.payload).toEqual({})
    // Seven minutes and fifty-nine seconds in — still inside the window, so the
    // refusal holds; only a claim that has OUTLIVED it is taken over.
    expect(drive(RUN, { claim: found(claimRow({ ...theirs, createdAt: Date.now() - (8 * 60_000 - 1_000) })), index: idx() }).code).toBe('RUN_EXISTS')
  })

  it('takes over another member’s stale claim in place rather than holding the id forever', () => {
    // Their dispatch never produced a run — a github_api failure, a driver that
    // never picked the event up — and the claim has outlived the window
    // (apps#672). `found()` ids the record `rec`, which is what `claimReplace`
    // overwrites.
    const stale = claimRow({ startedBy: OTHER.id, startedByEmail: OTHER.email, createdAt: Date.now() - (8 * 60_000 + 1_000) })
    const g = drive(RUN, { claim: found(stale), index: idx() })

    expect(g).toMatchObject({ dispatch: true, refused: false, code: '', staleReplace: true, writeClaim: false, claimRecordId: 'rec' })
    // A fresh nonce and this caller's name — never the abandoned row's.
    expect(g.driveKey).toMatch(/^[0-9a-f]{48}$/)
    expect(g.driveKey).not.toBe('a'.repeat(48))
    expect(g.claim).toMatchObject({ runId: RUN_ID, startedBy: MEMBER.id, startedByEmail: MEMBER.email, driveKey: g.driveKey })
    expect(g.claim!.createdAt).toBeGreaterThan(stale.createdAt as number)
    expect(g.payload.drive_key).toBe(g.driveKey)
  })

  it('still refuses a stale claim this CE gave no record id for — `claimReplace` would have nothing to key', () => {
    const aged = { startedBy: OTHER.id, createdAt: Date.now() - (8 * 60_000 + 1_000) }
    // The same row without the `id` `found()` wraps it in, and one whose
    // `createdAt` is not a number at all: neither is a row to take over on a guess.
    expect(drive(RUN, { claim: [{ fields: claimRow(aged) }], index: idx() }).code).toBe('RUN_EXISTS')
    expect(drive(RUN, { claim: found(claimRow({ ...aged, createdAt: '0' })), index: idx() }).code).toBe('RUN_EXISTS')
  })

  it('leaves the caller’s OWN claim standing however old it is — that reuse is what makes a retry safe', () => {
    const g = drive(RUN, { claim: found(claimRow({ createdAt: 1_756_800_000_000 })), index: idx() })

    expect(g).toMatchObject({ dispatch: true, staleReplace: false, writeClaim: false, claimRecordId: '', driveKey: 'a'.repeat(48) })
    expect(g.claim).toMatchObject({ startedBy: MEMBER.id, createdAt: 1_756_800_000_000 })
  })

  it('refuses a caller the endpoint cannot tie to a member — an unattributable run is not a run', () => {
    const g = drive(RUN, { user: { email: 'nobody@example.test' }, index: idx() })

    expect(g).toMatchObject({ dispatch: false, refused: true, code: 'BAD_REQUEST', writeClaim: false })
    expect(g.message).toContain('member')
    expect(drive(RUN, { user: undefined, index: idx() }).code).toBe('BAD_REQUEST')
  })

  it('mints nothing when this CE exposes no utils.randomToken', () => {
    const g = drive(RUN, { index: idx(), utils: undefined })

    expect(g).toMatchObject({ dispatch: false, refused: true, code: 'NO_RANDOM', status: 400, driveKey: '', claim: null })
    expect(g.message).toContain('randomToken')
    // …and an older CE that hands a `utils` without the helper is the same answer, not a throw.
    expect(drive(RUN, { index: idx(), utils: {} }).code).toBe('NO_RANDOM')
  })
})

/**
 * `resume` rides the shared run gate (D26) instead of a bare row lookup: a run
 * this caller cannot reach answers the SAME `RUN_NOT_FOUND` an unknown id
 * does, and the nonce it mints is written onto the run row (`rekey`) rather
 * than into a claim — the row already knows who owns it.
 */
describe('resume', () => {
  const RESUME = { id: RUN_ID, mode: 'resume' }

  it('needs the run gate to have opened', () => {
    // No row at all…
    expect(drive(RESUME, { index: index(WITH_DRIVER) }).code).toBe('RUN_NOT_FOUND')
    // …and someone else's run is the same answer, never a 403 (D26).
    const g = drive(RESUME, { run: found(runRow()), user: OTHER, index: index(WITH_DRIVER) })
    expect(g).toMatchObject({ dispatch: false, refused: true, code: 'RUN_NOT_FOUND', rekey: false })
  })

  it('mints the run row a fresh nonce and names the record to write it on', () => {
    const g = drive(RESUME, { run: found(runRow()), index: index(WITH_DRIVER) })

    expect(g).toMatchObject({ dispatch: true, rekey: true, writeClaim: false, claim: null, recordId: 'rec' })
    expect(g.driveKey).toMatch(/^[0-9a-f]{48}$/)
    expect(g.payload.drive_key).toBe(g.driveKey)
    expect(g.response).not.toContain(g.driveKey)
  })

  it('rotates the nonce rather than reusing the row’s — a previous driver’s key stops opening the run', () => {
    const g = drive(RESUME, { run: found(runRow({ driveKey: 'b'.repeat(48) })), index: index(WITH_DRIVER) })

    expect(g.rekey).toBe(true)
    expect(g.driveKey).not.toBe('b'.repeat(48))
  })
})
