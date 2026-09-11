/**
 * Parity between `runs/post`'s `admit.fn.js` (the real `function_handler`
 * code, at `.bffless/proxy-rules/workflow/rules/api/workflow/runs/post/` —
 * cannot import) and the mock's re-implementation inline in `handlers.ts`'s
 * `POST /api/workflow/runs` handler. `new Function` is test-only tooling to
 * execute the authored `.fn.js` source in isolation; it is never used by the
 * app or the mock at runtime. Same shape as `deleteGate.fn.parity.test.ts`.
 *
 * What `admit` decides (spec 11 §Attribution, D28) is who the new run belongs
 * to, and it is the *only* thing that decides it — the rule's `create` step no
 * longer carries `startedBy: user.id`. Four outcomes:
 *
 * 1. the run id is taken → 409, whatever else is true;
 * 2. a claim, and the request carries its nonce → the run is the CLAIMANT's,
 *    and the claim is consumed;
 * 3. a claim, and the nonce is missing or wrong → 409 (spec: "key missing or
 *    wrong → 409 RUN_EXISTS, as today"), so a driver that cannot prove it was
 *    dispatched cannot take the id either;
 * 4. no claim → the browser-started path, unchanged: the session's own member.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_MEMBER, MOCK_OTHER, db, setMockUser, type ClaimRow } from './db'
import { FINISHED_RUN } from './fixtures/finishedRun'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FN_PATH = join(
  appDir,
  '.bffless',
  'proxy-rules',
  'workflow',
  'rules',
  'api',
  'workflow',
  'runs',
  'post',
  'admit.fn.js',
)

interface AdmitResult {
  exists: boolean
  fresh: boolean
  claimed: boolean
  claimRecordId: string | null
  startedBy: string | null
  startedByEmail: string
  driveKey: string
}

type AdmitHandler = (ctx: {
  request?: { headers?: Record<string, unknown> }
  steps?: { find?: unknown; claim?: unknown }
  user?: { id?: string; email?: string }
}) => AdmitResult

function loadFnHandler(): AdmitHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

const DRIVE_KEY_HEADER = 'x-workflow-drive-key'
const RUN_ID = 'run_01claimed00000000000000000'
const KEY = 'c'.repeat(48)

/** The claim `run/drive` wrote for the requester — who is NOT the session posting the run (that is the driver). */
const CLAIM: ClaimRow = {
  runId: RUN_ID,
  impl: 'hello',
  workflow: 'hello',
  startedBy: MOCK_OTHER.id,
  startedByEmail: MOCK_OTHER.email,
  driveKey: KEY,
  createdAt: 1_756_800_000_000,
}

/** That claim as its `data_query` step answers it: the record id on the record, the columns under `fields`. */
const claimRecords = (overrides: Partial<ClaimRow> = {}) => [{ id: 'rec_claim', fields: { ...CLAIM, ...overrides } }]

const FN_CASES: {
  desc: string
  find?: unknown
  claim?: unknown
  header?: string
  user?: { id?: string; email?: string }
  expected: Partial<AdmitResult>
}[] = [
  {
    desc: 'the run id is already taken',
    find: [{ id: 'rec_run', fields: { runId: RUN_ID } }],
    claim: claimRecords(),
    header: KEY,
    expected: { exists: true, fresh: false, claimed: false },
  },
  {
    desc: 'a claim, redeemed with its nonce — the run is the claimant’s',
    claim: claimRecords(),
    header: KEY,
    expected: {
      exists: false,
      fresh: true,
      claimed: true,
      claimRecordId: 'rec_claim',
      startedBy: MOCK_OTHER.id,
      startedByEmail: MOCK_OTHER.email,
      driveKey: KEY,
    },
  },
  {
    desc: 'a claim, and no nonce at all',
    claim: claimRecords(),
    expected: { exists: true, fresh: false, claimed: false },
  },
  {
    desc: 'a claim, and the wrong nonce',
    claim: claimRecords(),
    header: 'd'.repeat(48),
    expected: { exists: true, fresh: false, claimed: false },
  },
  {
    desc: 'no claim — the browser-started path, the session’s own member',
    header: KEY,
    expected: {
      exists: false,
      fresh: true,
      claimed: false,
      startedBy: MOCK_MEMBER.id,
      startedByEmail: MOCK_MEMBER.email,
      driveKey: '',
    },
  },
  {
    desc: 'no claim and a caller CE could not tie to a member',
    user: {},
    expected: { exists: false, fresh: true, claimed: false, startedBy: null, startedByEmail: '', driveKey: '' },
  },
]

describe('runs/post admit.fn.js parity with the mock re-implementation', () => {
  let handler: AdmitHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it.each(FN_CASES)('admit.fn.js: $desc', ({ find, claim, header, user, expected }) => {
    const result = handler({
      request: { headers: header === undefined ? {} : { [DRIVE_KEY_HEADER]: header } },
      steps: { find: find ?? [], claim: claim ?? [] },
      user: user ?? { id: MOCK_MEMBER.id, email: MOCK_MEMBER.email },
    })

    expect(result).toMatchObject(expected)
    // `fresh` and `exists` are the two response_handlers' conditions — exactly
    // one of them ever runs, or a skipped responder leaves the reply to
    // whichever did (pipeline-execution.service.ts).
    expect(result.fresh).toBe(!result.exists)
  })

  it('never throws on the empty call CE makes of a bundle', () => {
    expect(() => handler({})).not.toThrow()
    expect(handler({})).toMatchObject({ exists: false, fresh: true, claimed: false })
  })

  describe('against the mock endpoint', () => {
    const row = { ...FINISHED_RUN.run, runId: RUN_ID, status: 'running' as const, finishedAt: null }

    const post = (header?: string) =>
      fetch('/api/workflow/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(header === undefined ? {} : { [DRIVE_KEY_HEADER]: header }),
        },
        body: JSON.stringify(row),
      })

    beforeEach(() => {
      // The session posting the run is the DRIVER's — an ordinary member, and
      // never the one who asked for the dispatch (that is `MOCK_OTHER` here).
      setMockUser(MOCK_MEMBER)
    })

    it('mock: the run id is already taken', async () => {
      db.runs.set(RUN_ID, { ...row, _id: 'rec_run' })
      db.claims.set(RUN_ID, { ...CLAIM })

      const res = await post(KEY)

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ code: 'RUN_EXISTS', error: 'a run with this id already exists' })
      // A refused create consumes nothing: the claim is still redeemable.
      expect(db.claims.get(RUN_ID)).toBeDefined()
    })

    it('mock: a claim, redeemed with its nonce — the run is the claimant’s and the claim is consumed', async () => {
      db.claims.set(RUN_ID, { ...CLAIM })

      const res = await post(KEY)

      expect(res.status).toBe(200)
      const stored = db.runs.get(RUN_ID)!
      expect(stored.startedBy).toBe(MOCK_OTHER.id)
      expect(stored.startedByEmail).toBe(MOCK_OTHER.email)
      // The nonce lands on the run row, which is what opens the gate's `drive`
      // door for every later request the driven page makes (D26 door 2).
      expect(stored.driveKey).toBe(KEY)
      expect(db.claims.has(RUN_ID)).toBe(false)
      // But it must never ride the CREATE response itself (spec 11 D28): the
      // driver already holds the nonce (it presented it in the request
      // header), and the harness must not hand it to whoever else can read
      // this response — nor to the workflow-headless job that writes it into
      // an uploaded run.json (apps#665 follow-up).
      const body = await res.clone().json()
      expect(body).not.toHaveProperty('driveKey')
      expect(await res.clone().text()).not.toContain(KEY)
    })

    it.each([
      { desc: 'no nonce at all', header: undefined },
      { desc: 'the wrong nonce', header: 'd'.repeat(48) },
    ])('mock: a claim, and $desc', async ({ header }) => {
      db.claims.set(RUN_ID, { ...CLAIM })

      const res = await post(header)

      expect(res.status).toBe(409)
      expect(db.runs.has(RUN_ID)).toBe(false)
      expect(db.claims.get(RUN_ID)).toBeDefined()
    })

    it('mock: no claim — the browser-started path, the session’s own member', async () => {
      const res = await post(KEY)

      expect(res.status).toBe(200)
      const stored = db.runs.get(RUN_ID)!
      expect(stored.startedBy).toBe(MOCK_MEMBER.id)
      expect(stored.startedByEmail).toBe(MOCK_MEMBER.email)
      expect(stored.driveKey).toBeUndefined()
    })
  })
})

/**
 * `runs/post`'s `shape.fn.js` — the `function_handler` step interposed
 * between `create` and `respond` (apps#665 follow-up) so the driver's nonce
 * `admit` wrote onto the row never rides the create response.
 */
describe('runs/post shape.fn.js', () => {
  const SHAPE_FN_PATH = join(
    appDir,
    '.bffless',
    'proxy-rules',
    'workflow',
    'rules',
    'api',
    'workflow',
    'runs',
    'post',
    'shape.fn.js',
  )
  type ShapeHandler = (ctx: { steps: { create: unknown } }) => unknown

  let shape: ShapeHandler

  beforeAll(() => {
    const src = readFileSync(SHAPE_FN_PATH, 'utf8')
    shape = new Function(`${src}\nreturn handler;`)()
  })

  it('strips driveKey from the created row, flat or nested under `fields`, and is a no-op otherwise', () => {
    expect(shape({ steps: { create: { id: 'rec_1', runId: 'r', driveKey: 'k' } } })).toEqual({ id: 'rec_1', runId: 'r' })
    expect(shape({ steps: { create: { id: 'rec_1', fields: { runId: 'r', driveKey: 'k' } } } })).toEqual({
      id: 'rec_1',
      fields: { runId: 'r' },
    })
    expect(shape({ steps: { create: { id: 'rec_1', runId: 'r' } } })).toEqual({ id: 'rec_1', runId: 'r' })
  })
})

/**
 * The other half of the loop: `run/drive` writes the claim the handler above
 * redeems. The mock endpoint stands in for the rule the same way every other
 * handler does — the body checks the real gate makes, then the claim write (or
 * the rekey), then the 202 receipt.
 */
describe('the mock run/drive endpoint', () => {
  const RUN_ID_2 = 'run_01driven000000000000000000'

  const drive = (body: unknown, headers: Record<string, string> = {}) =>
    fetch('/api/workflow/run/drive', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  const RUN = { id: RUN_ID_2, mode: 'run', impl: 'hello', workflow: 'hello', inputs: {} }

  it('writes the claim for the requester and answers a receipt that does not carry the key', async () => {
    const res = await drive(RUN)

    expect(res.status).toBe(202)
    const receipt = await res.json()
    expect(receipt).toEqual({ dispatched: true, runId: RUN_ID_2, repo: 'mock/impl', eventType: 'workflow-drive' })

    const claim = db.claims.get(RUN_ID_2)!
    expect(claim).toMatchObject({ runId: RUN_ID_2, impl: 'hello', workflow: 'hello', startedBy: MOCK_MEMBER.id, startedByEmail: MOCK_MEMBER.email })
    expect(claim.driveKey).not.toBe('')
    expect(JSON.stringify(receipt)).not.toContain(claim.driveKey)
  })

  it('is the key the driver’s runs/post redeems — the whole loop', async () => {
    await drive(RUN)
    const key = db.claims.get(RUN_ID_2)!.driveKey

    setMockUser(MOCK_OTHER) // the driver's own session, not the requester's
    const res = await fetch('/api/workflow/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workflow-drive-key': key },
      body: JSON.stringify({ ...FINISHED_RUN.run, runId: RUN_ID_2, status: 'running', finishedAt: null }),
    })

    expect(res.status).toBe(200)
    expect(db.runs.get(RUN_ID_2)!.startedBy).toBe(MOCK_MEMBER.id)
    expect(db.claims.has(RUN_ID_2)).toBe(false)
  })

  it('reuses the requester’s own claim and refuses another member’s', async () => {
    await drive(RUN)
    const key = db.claims.get(RUN_ID_2)!.driveKey

    expect((await drive(RUN)).status).toBe(202)
    expect(db.claims.get(RUN_ID_2)!.driveKey).toBe(key)

    setMockUser(MOCK_OTHER)
    const res = await drive(RUN)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('RUN_EXISTS')
    expect(db.claims.get(RUN_ID_2)!.startedBy).toBe(MOCK_MEMBER.id)
  })

  it('refuses a malformed body the way the real gate does', async () => {
    for (const body of [{ id: 'nope', mode: 'run' }, { id: RUN_ID_2, mode: 'drive' }, { id: RUN_ID_2, mode: 'run', workflow: 'hello', inputs: {} }]) {
      const res = await drive(body)
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('BAD_REQUEST')
    }
    expect(db.claims.size).toBe(0)
  })

  it('resume writes the nonce onto the run row, and refuses a run this caller cannot reach', async () => {
    const runId = FINISHED_RUN.run.runId
    db.runs.set(runId, { ...FINISHED_RUN.run, status: 'running', startedBy: MOCK_MEMBER.id, _id: 'rec_run' })

    const res = await drive({ id: runId, mode: 'resume' })
    expect(res.status).toBe(202)
    const key = db.runs.get(runId)!.driveKey
    expect(key).toMatch(/.+/)
    expect(JSON.stringify(await res.json())).not.toContain(key!)
    // No claim: the row already knows who owns it (D28).
    expect(db.claims.size).toBe(0)

    setMockUser(MOCK_OTHER)
    const refused = await drive({ id: runId, mode: 'resume' })
    expect(refused.status).toBe(400)
    expect((await refused.json()).code).toBe('RUN_NOT_FOUND')
  })
})
