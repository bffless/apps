/**
 * Parity between `normalize.fn.js` (the real `files/register` rule's standalone
 * `function_handler` code, at
 * `.bffless/proxy-rules/workflow/rules/api/workflow/files/register/post/` —
 * cannot import) and the mock's re-implementation inline in `handlers.ts`'s
 * `/api/workflow/files/register` handler. `new Function` is test-only tooling
 * to execute the authored `.fn.js` source in isolation; it is never used by
 * the app or the mock at runtime.
 *
 * Like `confine.fn.js`, this rule lives in this repo (not staged from
 * `bffless/workflow-implementations`), so there is no `describe.skipIf` here.
 *
 * What is being pinned (apps#472, spec 02): a pipeline may return a bare
 * uploads-relative path where a `file` output is declared, and `register`
 * must accept it *as the same object* `prepare` minted a full key for. On the
 * fn side that means every accepted spelling normalises to
 * `<owner>/<repo>/uploads/<uploads-relative>`; on the mock side it means a
 * PUT-then-register through each spelling lands on the same `db.files` key,
 * answers the same File ref, and writes the same `workflow_files` row — the
 * key the serve route and the delete sweep look up. One case table drives
 * both sides.
 *
 * Also pins the run locator `normalize.fn.js` grew for spec 11 (D29): `hasRun`/
 * `runId`/`runless` off the normalised uploads-relative path, alongside the
 * original `ok`/`notOk`/`storageKey`/`error`. Every `ok:true` case here
 * normalises to `REL`, which names `run_1` — seeded once (`beforeEach`) so the
 * gate the endpoint now runs finds it, owned by the mock's default member. A
 * separate `describe` block below drives the endpoint through the gate itself
 * (owner/other member/no such run/`inputs/`).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MOCK_ADMIN, MOCK_MEMBER, MOCK_OTHER, db, MOCK_UPLOADS_ROOT, nextId, setMockUser } from './db'
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
  'register',
  'post',
  'normalize.fn.js',
)

type NormalizeResult = {
  ok: boolean
  notOk: boolean
  storageKey: string
  error: string
  hasRun: boolean
  runId: string
  runless: boolean
}
type NormalizeHandler = (ctx: {
  request: { body: Record<string, unknown> }
  deployment: { owner: string; repo: string }
}) => NormalizeResult

function loadFnHandler(): NormalizeHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

/**
 * The same project on both sides: `MOCK_UPLOADS_ROOT` is
 * `<owner>/<repo>/uploads/` for this pair, so the full-key round-trip case can
 * be spelled once and mean the same thing to the raw `handler()` call and to
 * the mock's strip.
 */
const DEPLOYMENT = { owner: 'bffless', repo: 'workflow' }
const FULL_PREFIX = `${DEPLOYMENT.owner}/${DEPLOYMENT.repo}/uploads/`

const RUN_ID = 'run_1'
const REL = `workflows/hello/hello/runs/${RUN_ID}/slow/0/start/audio.wav`
const REFUSAL = 'storageKey must be an uploads-relative path under workflows/ with no traversal'

/**
 * `ok: true` cases carry the uploads-relative key `normalize.fn.js` normalises
 * *to* — the fn asserts `storageKey === <full prefix> + normalized`, the mock
 * asserts it is the `db.files` / `db.fileRecords` key the request landed on.
 * `ok: false` cases are the rule's `refuse` branch. Every `ok:true` row here
 * normalises to `REL`, so `hasRun`/`runId`/`runless` (spec 11 D29) are the
 * same for all five; `ok:false` rows are neither — `notOk` short-circuits
 * before the gate runs, and `runless` is `ok` minus `hasRun`.
 */
const CASES: {
  desc: string
  storageKey: unknown
  ok: boolean
  normalized?: string
  hasRun: boolean
  runId: string
  runless: boolean
}[] = [
  { desc: 'a bare uploads-relative path (a pipeline output)', storageKey: REL, ok: true, normalized: REL, hasRun: true, runId: RUN_ID, runless: false },
  { desc: 'an api/uploads/ prefix is stripped', storageKey: `api/uploads/${REL}`, ok: true, normalized: REL, hasRun: true, runId: RUN_ID, runless: false },
  {
    desc: 'a leading slash and the /api/uploads/ prefix are both stripped',
    storageKey: `/api/uploads/${REL}`,
    ok: true,
    normalized: REL,
    hasRun: true,
    runId: RUN_ID,
    runless: false,
  },
  { desc: 'a leading slash is stripped', storageKey: `/${REL}`, ok: true, normalized: REL, hasRun: true, runId: RUN_ID, runless: false },
  {
    desc: 'the full key prepare minted round-trips',
    storageKey: `${FULL_PREFIX}${REL}`,
    ok: true,
    normalized: REL,
    hasRun: true,
    runId: RUN_ID,
    runless: false,
  },
  {
    // Same directory as `REL`'s run but no `runs/<id>/` segment: `inputs/` is
    // runless at the fn level (D18) without needing a different filename, which
    // keeps the shared `'audio.wav'`/sub_dir assertions below meaningful for
    // this row too. The endpoint-level "no run needed at all" case (an actual
    // `inputs/` scope, any member) lives in the ownership `describe` below.
    desc: 'no runs/ segment is runless (D29) even under the same tree',
    storageKey: 'workflows/hello/hello/runs/not-a-run-id/slow/0/start/audio.wav',
    ok: true,
    normalized: 'workflows/hello/hello/runs/not-a-run-id/slow/0/start/audio.wav',
    hasRun: false,
    runId: '',
    runless: true,
  },
  {
    // Fix round 1: see `confine.fn.parity.test.ts`'s equivalent row — the
    // `runs` segment matches case-insensitively so the gate is at least as
    // strict as a case-insensitive filesystem's key equality.
    desc: 'the runs segment matches case-insensitively (RUNS)',
    storageKey: `workflows/hello/hello/RUNS/${RUN_ID}/slow/0/start/audio.wav`,
    ok: true,
    normalized: `workflows/hello/hello/RUNS/${RUN_ID}/slow/0/start/audio.wav`,
    hasRun: true,
    runId: RUN_ID,
    runless: false,
  },
  { desc: 'outside the harness prefix', storageKey: 'uploads/other/x.svg', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a bare other/ path', storageKey: 'other/x', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'directory traversal', storageKey: 'workflows/../secrets/x', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a double slash', storageKey: 'workflows//x', ok: false, hasRun: false, runId: '', runless: false },
  // Fix round 2: a local-filesystem storage adapter normalises `/./` away, so
  // the two spellings name one object — see `confine.fn.parity.test.ts`.
  { desc: 'a /./ segment', storageKey: `workflows/hello/./runs/${RUN_ID}/x`, ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'an empty storageKey', storageKey: '', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a non-string storageKey', storageKey: undefined, ok: false, hasRun: false, runId: '', runless: false },
]

/** `REL`'s run — owned by `MOCK_MEMBER`, the mock's default identity. */
function seedCaseRun(): void {
  db.runs.set(RUN_ID, { ...FINISHED_RUN.run, runId: RUN_ID, _id: nextId() })
}

const json = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('normalize.fn.js parity with the mock re-implementation', () => {
  let handler: NormalizeHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  beforeEach(() => {
    seedCaseRun()
  })

  it.each(CASES)('normalize.fn.js: $desc', ({ storageKey, ok, normalized, hasRun, runId, runless }) => {
    // `impl`/`workflow` are valid single segments throughout this table — the
    // `IDENTIFIER_CASES` block below is what pins THEIR validation (fix round 2).
    const result = handler({ request: { body: { impl: 'hello', workflow: 'hello', storageKey } }, deployment: DEPLOYMENT })
    expect(result.ok).toBe(ok)
    expect(result.notOk).toBe(!ok)
    expect(result.storageKey).toBe(ok ? `${FULL_PREFIX}${normalized}` : '')
    expect(result.error).toBe(ok ? '' : REFUSAL)
    expect(result.hasRun).toBe(hasRun)
    expect(result.runId).toBe(runId)
    expect(result.runless).toBe(runless)
  })

  it.each(CASES)('mock /api/workflow/files/register: $desc', async ({ storageKey, ok, normalized }) => {
    // The object `prepare` would have minted the key for, PUT under the
    // uploads-relative key exactly as the trio's PUT stores it.
    if (ok) {
      const put = await fetch(`/mock-upload/${normalized}`, {
        method: 'PUT',
        headers: { 'content-type': 'audio/wav' },
        body: new Uint8Array([1, 2, 3]),
      })
      expect(put.status).toBe(200)
    }

    const res = await json('/api/workflow/files/register', {
      impl: 'hello',
      workflow: 'hello',
      scope: 'runs/run_1/slow/0/start',
      storageKey,
    })

    if (!ok) {
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ success: false, error: { code: 'BAD_PATH', message: REFUSAL } })
      expect(db.fileRecords.size).toBe(0)
      return
    }

    // Every `ok` case carries the key it normalises to (see `CASES`).
    const key = normalized ?? ''
    expect(res.status).toBe(200)
    // The same File ref whatever the spelling — and the object it points at is served.
    expect(await res.json()).toEqual({
      path: key,
      name: 'audio.wav',
      contentType: 'audio/wav',
      size: 3,
      url: `/api/uploads/${key}`,
    })
    expect([...db.fileRecords.keys()]).toEqual([key])
    expect(db.fileRecords.get(key)).toMatchObject({
      filename: 'audio.wav',
      storage_path: `${MOCK_UPLOADS_ROOT}${key}`,
      // The row's `sub_dir` is derived from the KEY (`registerFileRecord`), not
      // the request's `scope` — every case here shares the `audio.wav` leaf, so
      // this is just the key with that leaf trimmed off.
      sub_dir: key.slice(0, key.lastIndexOf('/')),
      size: 3,
      url: `/api/uploads/${key}`,
    })
    expect((await fetch(`/api/uploads/${key}`)).status).toBe(200)
  })

  /**
   * Fix round 2: `register_upload`'s `subDir` templates
   * `workflows/{{impl}}/{{workflow}}/{{scope}}` from the raw body, exactly as
   * `files/prepare`'s `presigned_upload` does — so `normalize.fn.js` now
   * mirrors prepare's `isSegment`. Both sides answer the 400 with the
   * identifier message rather than the storageKey one, so a caller can tell
   * which half of the body was refused.
   */
  const IDENTIFIER_CASES: { desc: string; fields: Record<string, unknown> }[] = [
    { desc: 'a slash in workflow', fields: { workflow: 'x/runs/run_VICTIM/step' } },
    { desc: 'a slash in impl', fields: { impl: 'x/runs' } },
    { desc: 'traversal in workflow', fields: { workflow: '../other' } },
    { desc: 'an empty workflow', fields: { workflow: '' } },
    { desc: 'a missing impl', fields: { impl: undefined } },
  ]
  const IDENTIFIER_REFUSAL = 'impl and workflow must each be a single path segment'

  it.each(IDENTIFIER_CASES)('normalize.fn.js: $desc → notOk', ({ fields }) => {
    const result = handler({
      request: { body: { impl: 'hello', workflow: 'hello', storageKey: REL, ...fields } },
      deployment: DEPLOYMENT,
    })
    expect(result.ok).toBe(false)
    expect(result.notOk).toBe(true)
    expect(result.storageKey).toBe('')
    expect(result.error).toBe(IDENTIFIER_REFUSAL)
  })

  it.each(IDENTIFIER_CASES)('mock /api/workflow/files/register: $desc → 400', async ({ fields }) => {
    const res = await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: REL, ...fields })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: { code: 'BAD_PATH', message: IDENTIFIER_REFUSAL } })
    expect(db.fileRecords.size).toBe(0)
  })

  it('a bare path and the prepare-minted key register the same object as the same row', async () => {
    const prepared = (await (
      await json('/api/workflow/files/prepare', {
        impl: 'hello',
        workflow: 'hello',
        scope: 'runs/run_1/slow/0/start',
        filename: 'audio.wav',
      })
    ).json()) as { uploadUrl: string; storageKey: string }
    expect(prepared.storageKey).toBe(REL)
    await fetch(prepared.uploadUrl, { method: 'PUT', body: new Uint8Array([9, 9]) })

    const viaPrepared = await (
      await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: prepared.storageKey, originalName: 'audio.wav' })
    ).json()
    const rowViaPrepared = { ...db.fileRecords.get(REL) }

    const viaBare = await (
      await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: `${MOCK_UPLOADS_ROOT}${REL}` })
    ).json()

    expect(viaBare).toEqual(viaPrepared)
    expect(db.fileRecords.size).toBe(1)
    expect(db.fileRecords.get(REL)).toEqual(rowViaPrepared)
  })
})

/**
 * The shared run gate (spec 11 D29), wired into `files/register` through
 * `normalize.fn.js`'s `hasRun`/`runId`. Mirrors `runGate.endpoints.test.ts`'s
 * arrangement (Task B4): a fixture run owned by `MOCK_MEMBER`, `MOCK_OTHER` as
 * a member who did not start it.
 */
describe('files/register: run ownership (spec 11 D29)', () => {
  const RUN_ID = 'run_owned00000000000000000000'
  const GHOST_ID = 'run_ghost0000000000000000000'

  beforeEach(() => {
    db.runs.set(RUN_ID, { ...FINISHED_RUN.run, runId: RUN_ID, _id: nextId() })
  })

  it('registers an object under the owner’s own run', async () => {
    setMockUser(MOCK_MEMBER)
    const key = `workflows/hello/hello/runs/${RUN_ID}/slow/0/start/clip.mp4`
    await fetch(`/mock-upload/${key}`, { method: 'PUT', body: new Uint8Array([1]) })

    const res = await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: key, originalName: 'clip.mp4' })
    expect(res.status).toBe(200)
  })

  it('refuses an object under another member’s run — 404, not 403 (D26)', async () => {
    setMockUser(MOCK_OTHER)
    const key = `workflows/hello/hello/runs/${RUN_ID}/slow/0/start/clip.mp4`
    await fetch(`/mock-upload/${key}`, { method: 'PUT', body: new Uint8Array([1]) })

    const res = await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: key, originalName: 'clip.mp4' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
  })

  it('registers an inputs/ object for any member — no runId, stays member-wide (D18)', async () => {
    setMockUser(MOCK_OTHER)
    const key = 'workflows/hello/hello/inputs/u1/cat.png'
    await fetch(`/mock-upload/${key}`, { method: 'PUT', body: new Uint8Array([1]) })

    const res = await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: key, originalName: 'cat.png' })
    expect(res.status).toBe(200)
  })

  it('refuses a miscased run id rather than reading it as runless — 404 (fix round 2)', async () => {
    setMockUser(MOCK_OTHER)
    const key = `workflows/hello/hello/runs/${RUN_ID.toUpperCase()}/f`
    await fetch(`/mock-upload/${key}`, { method: 'PUT', body: new Uint8Array([1]) })

    const res = await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: key, originalName: 'f' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
  })

  it('normalize.fn.js captures a miscased run id rather than answering runless (fix round 2)', () => {
    const result = loadFnHandler()({
      request: { body: { impl: 'hello', workflow: 'hello', storageKey: `workflows/hello/hello/runs/${RUN_ID.toUpperCase()}/f` } },
      deployment: DEPLOYMENT,
    })
    expect(result.hasRun).toBe(true)
    expect(result.runId).toBe(RUN_ID.toUpperCase())
    expect(result.runless).toBe(false)
  })

  it('refuses another member’s run even through an uppercase RUNS segment — 404 (fix round 1)', async () => {
    setMockUser(MOCK_OTHER)
    const key = `workflows/hello/hello/RUNS/${RUN_ID}/slow/0/start/clip.mp4`
    await fetch(`/mock-upload/${key}`, { method: 'PUT', body: new Uint8Array([1]) })

    const res = await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: key, originalName: 'clip.mp4' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
  })

  it('an asked all-scope project admin may register into another member’s run (D27)', async () => {
    setMockUser({ ...MOCK_ADMIN, id: 'user_admin_register' })
    const key = `workflows/hello/hello/runs/${RUN_ID}/slow/0/start/clip.mp4`
    await fetch(`/mock-upload/${key}`, { method: 'PUT', body: new Uint8Array([1]) })

    const res = await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: key, originalName: 'clip.mp4', scope: 'all' })
    expect(res.status).toBe(200)
  })

  it('refuses a runs/<id>/ object whose run does not exist — 404', async () => {
    setMockUser(MOCK_MEMBER)
    const key = `workflows/hello/hello/runs/${GHOST_ID}/x.png`
    await fetch(`/mock-upload/${key}`, { method: 'PUT', body: new Uint8Array([1]) })

    const res = await json('/api/workflow/files/register', { impl: 'hello', workflow: 'hello', storageKey: key, originalName: 'x.png' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
  })
})
