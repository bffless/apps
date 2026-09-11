/**
 * Parity between `confine.fn.js` (the real rule's standalone `function_handler`
 * code, at `.bffless/proxy-rules/workflow/rules/api/workflow/files/sign/post/`
 * — cannot import) and the mock's re-implementation inline in `handlers.ts`'s
 * `/api/workflow/files/sign` handler. `new Function` is test-only tooling to
 * execute the authored `.fn.js` source in isolation; it is never used by the
 * app or the mock at runtime.
 *
 * Unlike `analyze.fn.js`, this rule lives in this repo (not staged from
 * `bffless/workflow-implementations`), so there is no `describe.skipIf` here.
 *
 * The mock does not expose its path predicate as a standalone helper — it's
 * inline in the `http.post` handler body — so this table drives both sides:
 * the raw `handler()` call against `confine.fn.js`, and an actual request to
 * the mock's `/api/workflow/files/sign` endpoint, sharing one case table
 * between them.
 *
 * Also pins the run locator `confine.fn.js` grew for spec 11 (D29): `hasRun`/
 * `runId`/`runless` alongside the original `ok`/`notOk`/`storagePath`. A
 * separate `describe` block below drives the endpoint through the shared gate
 * itself (owner/other member/no such run/`inputs/`) — the case table here only
 * has one `runs/<id>/` row (`run_1`), so it seeds that one run once.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_ADMIN, MOCK_MEMBER, MOCK_OTHER, db, nextId, setMockUser } from './db'
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
  'files',
  'sign',
  'post',
  'confine.fn.js',
)

type ConfineResult = {
  ok: boolean
  notOk: boolean
  storagePath: string
  hasRun: boolean
  runId: string
  runless: boolean
}
type ConfineHandler = (ctx: {
  request: { body: Record<string, unknown> }
  deployment: { owner: string; repo: string }
}) => ConfineResult

function loadFnHandler(): ConfineHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

const DEPLOYMENT = { owner: 'o', repo: 'r' }

/** Seeded once per test below (a `beforeEach`) so the one `hasRun` row in `CASES` — `run_1` — resolves for both the fn-level table and the mock endpoint sub-test. */
const CASE_RUN_ID = 'run_1'

/**
 * `ok: true` cases carry the path `confine.fn.js` normalises *to* — used to
 * assert both the fn's `storagePath` and the mock's signed URL. `ok: false`
 * cases include the ones `handlers.test.ts`'s own refusal test already
 * covers (outside the `workflows/` prefix, traversal, a double slash, an
 * empty path) plus the normalisation-only cases only the rule and the mock
 * implement (leading `/`, an `/api/uploads/` prefix, a trailing `?query`).
 *
 * `hasRun`/`runId`/`runless` (spec 11 D29): every `ok:false` row is neither —
 * `notOk` short-circuits the real rule before the gate ever runs, and
 * `runless` is `ok` minus `hasRun`, so it can never be true off a bad path.
 */
const CASES: { desc: string; path: unknown; ok: boolean; normalized?: string; hasRun: boolean; runId: string; runless: boolean }[] = [
  {
    desc: 'a confined run path',
    path: `workflows/hello/interactive/runs/${CASE_RUN_ID}/poster.svg`,
    ok: true,
    normalized: `workflows/hello/interactive/runs/${CASE_RUN_ID}/poster.svg`,
    hasRun: true,
    runId: CASE_RUN_ID,
    runless: false,
  },
  {
    desc: 'a leading slash is stripped',
    path: '/workflows/hello/x.png',
    ok: true,
    normalized: 'workflows/hello/x.png',
    hasRun: false,
    runId: '',
    runless: true,
  },
  {
    desc: 'an api/uploads/ prefix is stripped',
    path: 'api/uploads/workflows/hello/x.png',
    ok: true,
    normalized: 'workflows/hello/x.png',
    hasRun: false,
    runId: '',
    runless: true,
  },
  {
    desc: 'a leading slash and the /api/uploads/ prefix are both stripped',
    path: '/api/uploads/workflows/hello/x.png',
    ok: true,
    normalized: 'workflows/hello/x.png',
    hasRun: false,
    runId: '',
    runless: true,
  },
  {
    desc: 'a trailing ?query is dropped',
    path: 'workflows/hello/x.png?foo=bar',
    ok: true,
    normalized: 'workflows/hello/x.png',
    hasRun: false,
    runId: '',
    runless: true,
  },
  {
    desc: 'an inputs/ path is runless (D18: member-wide, reused across runs)',
    path: 'workflows/hello/hello/inputs/u1/cat.png',
    ok: true,
    normalized: 'workflows/hello/hello/inputs/u1/cat.png',
    hasRun: false,
    runId: '',
    runless: true,
  },
  {
    // Fix round 1: CE's file_serve_handler builds the storage key from the same
    // raw path with no case folding, so on a case-insensitive filesystem
    // `RUNS/…` and `runs/…` name the SAME object — the gate must match at
    // least as loosely.
    desc: 'the runs segment matches case-insensitively (RUNS)',
    path: `workflows/hello/interactive/RUNS/${CASE_RUN_ID}/poster.svg`,
    ok: true,
    normalized: `workflows/hello/interactive/RUNS/${CASE_RUN_ID}/poster.svg`,
    hasRun: true,
    runId: CASE_RUN_ID,
    runless: false,
  },
  { desc: 'outside the harness prefix', path: 'uploads/other/x.svg', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a bare other/ path', path: 'other/x', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'directory traversal', path: 'workflows/../secrets/x', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a double slash', path: 'workflows//x', ok: false, hasRun: false, runId: '', runless: false },
  // Fix round 2: a local-filesystem storage adapter normalises `/./` away
  // (`path.resolve`), so the two spellings name one object while only one of
  // them is the path this grammar read the run off.
  { desc: 'a /./ segment', path: `workflows/hello/./runs/${CASE_RUN_ID}/x`, ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'an empty path', path: '', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a non-string path', path: undefined, ok: false, hasRun: false, runId: '', runless: false },
]

/** The one `hasRun` case's run — owned by `MOCK_MEMBER`, the mock's default identity. */
function seedCaseRun(): void {
  db.runs.set(CASE_RUN_ID, { ...FINISHED_RUN.run, runId: CASE_RUN_ID, _id: nextId() })
}

describe('confine.fn.js parity with the mock re-implementation', () => {
  let handler: ConfineHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  beforeEach(() => {
    seedCaseRun()
  })

  it.each(CASES)('confine.fn.js: $desc', ({ path, ok, normalized, hasRun, runId, runless }) => {
    const result = handler({ request: { body: { path } }, deployment: DEPLOYMENT })
    expect(result.ok).toBe(ok)
    expect(result.notOk).toBe(!ok)
    expect(result.storagePath).toBe(ok ? `${DEPLOYMENT.owner}/${DEPLOYMENT.repo}/uploads/${normalized}` : '')
    expect(result.hasRun).toBe(hasRun)
    expect(result.runId).toBe(runId)
    expect(result.runless).toBe(runless)
  })

  it.each(CASES)('mock /api/workflow/files/sign: $desc', async ({ path, ok, normalized }) => {
    const res = await fetch('/api/workflow/files/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    expect(res.status).toBe(ok ? 200 : 400)
    if (ok) {
      const { url } = await res.json()
      expect(new URL(url).pathname).toBe(`/api/uploads/${normalized}`)
    } else {
      expect((await res.json()).error).toContain('workflows/')
    }
  })
})

/**
 * The shared run gate (spec 11 D29), wired into `files/sign` through
 * `confine.fn.js`'s `hasRun`/`runId`. Mirrors `runGate.endpoints.test.ts`'s
 * arrangement (Task B4) for the run-record routes: a fixture run owned by
 * `MOCK_MEMBER`, `MOCK_OTHER` as a member who did not start it.
 */
describe('files/sign: run ownership (spec 11 D29)', () => {
  const RUN_ID = 'run_owned00000000000000000000'
  const GHOST_ID = 'run_ghost0000000000000000000'

  const sign = (path: string, scope?: string) =>
    fetch('/api/workflow/files/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scope === undefined ? { path } : { path, scope }),
    })

  beforeEach(() => {
    db.runs.set(RUN_ID, { ...FINISHED_RUN.run, runId: RUN_ID, _id: nextId() })
  })

  it('signs a path under the owner’s own run', async () => {
    setMockUser(MOCK_MEMBER)
    const res = await sign(`workflows/hello/hello/runs/${RUN_ID}/poster.svg`)
    expect(res.status).toBe(200)
  })

  it('refuses a path under another member’s run — 404, not 403 (D26)', async () => {
    setMockUser(MOCK_OTHER)
    const res = await sign(`workflows/hello/hello/runs/${RUN_ID}/poster.svg`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('run not found')
  })

  it('signs an inputs/ path for any member — no runId, stays member-wide (D18)', async () => {
    setMockUser(MOCK_OTHER)
    const res = await sign('workflows/hello/hello/inputs/u1/cat.png')
    expect(res.status).toBe(200)
  })

  it('refuses a runs/<id>/ path whose run does not exist — 404', async () => {
    setMockUser(MOCK_MEMBER)
    const res = await sign(`workflows/hello/hello/runs/${GHOST_ID}/x.png`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('run not found')
  })

  it('refuses another member’s run even through an uppercase RUNS segment — 404 (fix round 1)', async () => {
    setMockUser(MOCK_OTHER)
    const res = await sign(`workflows/hello/hello/RUNS/${RUN_ID}/poster.svg`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('run not found')
  })

  /**
   * Fix round 2: the run ID itself matched case-SENSITIVELY, so a miscased
   * `RUN_…` was not captured — `runId: ''` → `runless: true` → admitted
   * member-wide, while a case-insensitive volume served the very same object.
   * Captured, the miscased id goes verbatim into the `runId eq` filter and
   * matches no row, so the answer is the same 404 an unknown id gets.
   */
  it('refuses a miscased run id rather than reading it as runless — 404 (fix round 2)', async () => {
    setMockUser(MOCK_OTHER)
    const res = await sign(`workflows/hello/hello/runs/${RUN_ID.toUpperCase()}/f`)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('run not found')
  })

  it('confine.fn.js captures a miscased run id rather than answering runless (fix round 2)', () => {
    const handler = loadFnHandler()
    const result = handler({
      request: { body: { path: `workflows/hello/hello/runs/${RUN_ID.toUpperCase()}/f` } },
      deployment: DEPLOYMENT,
    })
    expect(result.hasRun).toBe(true)
    expect(result.runId).toBe(RUN_ID.toUpperCase())
    expect(result.runless).toBe(false)
  })

  it('refuses a /./ path — 400 on both sides (fix round 2)', async () => {
    setMockUser(MOCK_MEMBER)
    expect(loadFnHandler()({ request: { body: { path: `workflows/hello/./runs/${RUN_ID}/f` } }, deployment: DEPLOYMENT }).notOk).toBe(true)

    const res = await sign(`workflows/hello/./runs/${RUN_ID}/f`)
    expect(res.status).toBe(400)
  })

  it('an asked all-scope project admin may sign another member’s run (D27)', async () => {
    setMockUser({ ...MOCK_ADMIN, id: 'user_admin_sign' })
    const res = await sign(`workflows/hello/hello/runs/${RUN_ID}/poster.svg`, 'all')
    expect(res.status).toBe(200)
  })
})
