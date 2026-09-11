/**
 * Parity between the serve rule's `confine.fn.js` (the real rule's standalone
 * `function_handler` code, at
 * `.bffless/proxy-rules/workflow/rules/api/uploads/workflows/[...path]/` —
 * cannot import) and the mock's re-implementation inline in `handlers.ts`'s
 * `GET /api/uploads/*` handler. `new Function` is test-only tooling to execute
 * the authored `.fn.js` source in isolation; it is never used by the app or
 * the mock at runtime.
 *
 * Same grammar and output shape as `files/sign`'s `confine.fn.js`
 * (`confine.fn.parity.test.ts`), read off `request.path` instead of
 * `request.body.path` — CE's file_serve_handler answers a GET directly, so
 * there is no body. The one behavioural difference (spec 11 D29): this rule
 * has NO 400. A path that fails to parse is `ok:false`/`hasRun:false`, and the
 * rule runs `runGate` unconditionally rather than skipping it the way
 * sign/prepare/register do ahead of their own 400 — so every refusal here,
 * parse failure or ownership, is the SAME 404.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_MEMBER, MOCK_OTHER, db, nextId, setMockUser } from './db'
import { FINISHED_RUN } from './fixtures/finishedRun'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FN_PATH = join(
  appDir,
  '.bffless',
  'proxy-rules',
  'workflow',
  'rules',
  'api',
  'uploads',
  'workflows',
  '[...path]',
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
type ConfineHandler = (ctx: { request: { path: string }; deployment: { owner: string; repo: string } }) => ConfineResult

function loadFnHandler(): ConfineHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

const DEPLOYMENT = { owner: 'o', repo: 'r' }
const CASE_RUN_ID = 'run_1'

/**
 * `path` is `request.path` (CE's own, not uploads-relative-stripped) — a
 * confined served route always carries the `/api/uploads/` head, which the fn
 * strips the same way `files/sign`'s does.
 */
const CASES: {
  desc: string
  path: unknown
  ok: boolean
  normalized?: string
  hasRun: boolean
  runId: string
  runless: boolean
}[] = [
  {
    desc: 'a confined run path',
    path: `/api/uploads/workflows/hello/interactive/runs/${CASE_RUN_ID}/poster.svg`,
    ok: true,
    normalized: `workflows/hello/interactive/runs/${CASE_RUN_ID}/poster.svg`,
    hasRun: true,
    runId: CASE_RUN_ID,
    runless: false,
  },
  {
    desc: 'an inputs/ path is runless (D18)',
    path: '/api/uploads/workflows/hello/hello/inputs/u1/cat.png',
    ok: true,
    normalized: 'workflows/hello/hello/inputs/u1/cat.png',
    hasRun: false,
    runId: '',
    runless: true,
  },
  { desc: 'outside the harness prefix', path: '/api/uploads/other/x.svg', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'directory traversal', path: '/api/uploads/workflows/../secrets/x', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a double slash', path: '/api/uploads/workflows//x', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'an empty path', path: '/api/uploads/', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a non-string path', path: undefined, ok: false, hasRun: false, runId: '', runless: false },
]

describe("the serve rule's confine.fn.js parity with the mock re-implementation", () => {
  let handler: ConfineHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  beforeEach(() => {
    db.runs.set(CASE_RUN_ID, { ...FINISHED_RUN.run, runId: CASE_RUN_ID, _id: nextId() })
  })

  it.each(CASES)('confine.fn.js: $desc', ({ path, ok, normalized, hasRun, runId, runless }) => {
    const result = handler({ request: { path: path as string }, deployment: DEPLOYMENT })
    expect(result.ok).toBe(ok)
    expect(result.notOk).toBe(!ok)
    expect(result.storagePath).toBe(ok ? `${DEPLOYMENT.owner}/${DEPLOYMENT.repo}/uploads/${normalized}` : '')
    expect(result.hasRun).toBe(hasRun)
    expect(result.runId).toBe(runId)
    expect(result.runless).toBe(runless)
  })

  // `undefined`/`'/api/uploads/'` have no path segment for MSW's `/api/uploads/*`
  // to capture, so they are not exercised through a real `fetch()` — the
  // fn-level table above already pins their `ok:false` outcome, and the gate's
  // 404-for-any-failed-parse is proven by the fetchable cases below plus the
  // ownership `describe` after this one.
  const FETCHABLE = CASES.filter(
    (c): c is typeof c & { path: string } => typeof c.path === 'string' && c.path !== '/api/uploads/',
  )

  it.each(FETCHABLE)('mock GET /api/uploads/*: $desc', async ({ path, ok, normalized }) => {
    const key = normalized ?? ''
    if (ok) db.files.set(key, { bytes: new Uint8Array([1, 2, 3]), contentType: 'application/octet-stream' })

    const res = await fetch(path)

    if (ok) {
      expect(res.status).toBe(200)
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    } else {
      // No 400 on this route (see the file banner): a bad path is the SAME 404
      // JSON body the gate's own refusal answers.
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not found' })
    }
  })
})

/**
 * The shared run gate (spec 11 D29), wired into the serve rule through
 * `confine.fn.js`'s `hasRun`/`runId`. Mirrors `runGate.endpoints.test.ts`'s
 * arrangement (Task B4): a fixture run owned by `MOCK_MEMBER`, `MOCK_OTHER` as
 * a member who did not start it.
 */
describe('serve: run ownership (spec 11 D29)', () => {
  const RUN_ID = 'run_owned00000000000000000000'
  const GHOST_ID = 'run_ghost0000000000000000000'

  beforeEach(() => {
    db.runs.set(RUN_ID, { ...FINISHED_RUN.run, runId: RUN_ID, _id: nextId() })
  })

  it('serves an object under the owner’s own run', async () => {
    setMockUser(MOCK_MEMBER)
    const key = `workflows/hello/hello/runs/${RUN_ID}/poster.png`
    db.files.set(key, { bytes: new Uint8Array([9]), contentType: 'image/png' })

    const res = await fetch(`/api/uploads/${key}`)
    expect(res.status).toBe(200)
  })

  it('refuses an object under another member’s run — 404 with the gate’s body, not the plain not-found', async () => {
    setMockUser(MOCK_OTHER)
    const key = `workflows/hello/hello/runs/${RUN_ID}/poster.png`
    db.files.set(key, { bytes: new Uint8Array([9]), contentType: 'image/png' })

    const res = await fetch(`/api/uploads/${key}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('serves an inputs/ object for any member — no runId, stays member-wide (D18)', async () => {
    setMockUser(MOCK_OTHER)
    const key = 'workflows/hello/hello/inputs/u1/cat.png'
    db.files.set(key, { bytes: new Uint8Array([9]), contentType: 'image/png' })

    const res = await fetch(`/api/uploads/${key}`)
    expect(res.status).toBe(200)
  })

  it('refuses a runs/<id>/ object whose run does not exist — 404', async () => {
    setMockUser(MOCK_MEMBER)
    const key = `workflows/hello/hello/runs/${GHOST_ID}/x.png`
    db.files.set(key, { bytes: new Uint8Array([9]), contentType: 'image/png' })

    const res = await fetch(`/api/uploads/${key}`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })
})
