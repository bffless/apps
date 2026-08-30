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
 * `bffless/workflow-hello`), so there is no `describe.skipIf` here.
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
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, MOCK_UPLOADS_ROOT } from './db'

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

type NormalizeResult = { ok: boolean; notOk: boolean; storageKey: string; error: string }
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

const REL = 'workflows/hello/hello/runs/run_1/slow/0/start/audio.wav'
const REFUSAL = 'storageKey must be an uploads-relative path under workflows/ with no traversal'

/**
 * `ok: true` cases carry the uploads-relative key `normalize.fn.js` normalises
 * *to* — the fn asserts `storageKey === <full prefix> + normalized`, the mock
 * asserts it is the `db.files` / `db.fileRecords` key the request landed on.
 * `ok: false` cases are the rule's `refuse` branch.
 */
const CASES: { desc: string; storageKey: unknown; ok: boolean; normalized?: string }[] = [
  { desc: 'a bare uploads-relative path (a pipeline output)', storageKey: REL, ok: true, normalized: REL },
  { desc: 'an api/uploads/ prefix is stripped', storageKey: `api/uploads/${REL}`, ok: true, normalized: REL },
  {
    desc: 'a leading slash and the /api/uploads/ prefix are both stripped',
    storageKey: `/api/uploads/${REL}`,
    ok: true,
    normalized: REL,
  },
  { desc: 'a leading slash is stripped', storageKey: `/${REL}`, ok: true, normalized: REL },
  {
    desc: 'the full key prepare minted round-trips',
    storageKey: `${FULL_PREFIX}${REL}`,
    ok: true,
    normalized: REL,
  },
  { desc: 'outside the harness prefix', storageKey: 'uploads/other/x.svg', ok: false },
  { desc: 'a bare other/ path', storageKey: 'other/x', ok: false },
  { desc: 'directory traversal', storageKey: 'workflows/../secrets/x', ok: false },
  { desc: 'a double slash', storageKey: 'workflows//x', ok: false },
  { desc: 'an empty storageKey', storageKey: '', ok: false },
  { desc: 'a non-string storageKey', storageKey: undefined, ok: false },
]

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

  it.each(CASES)('normalize.fn.js: $desc', ({ storageKey, ok, normalized }) => {
    const result = handler({ request: { body: { storageKey } }, deployment: DEPLOYMENT })
    expect(result.ok).toBe(ok)
    expect(result.notOk).toBe(!ok)
    expect(result.storageKey).toBe(ok ? `${FULL_PREFIX}${normalized}` : '')
    expect(result.error).toBe(ok ? '' : REFUSAL)
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
      sub_dir: 'workflows/hello/hello/runs/run_1/slow/0/start',
      size: 3,
      url: `/api/uploads/${key}`,
    })
    expect((await fetch(`/api/uploads/${key}`)).status).toBe(200)
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
      await json('/api/workflow/files/register', { storageKey: prepared.storageKey, originalName: 'audio.wav' })
    ).json()
    const rowViaPrepared = { ...db.fileRecords.get(REL) }

    const viaBare = await (await json('/api/workflow/files/register', { storageKey: `${MOCK_UPLOADS_ROOT}${REL}` })).json()

    expect(viaBare).toEqual(viaPrepared)
    expect(db.fileRecords.size).toBe(1)
    expect(db.fileRecords.get(REL)).toEqual(rowViaPrepared)
  })
})
