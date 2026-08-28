/**
 * Parity between `confine.fn.js` (the real rule's standalone `function_handler`
 * code, at `.bffless/proxy-rules/workflow/rules/api/workflow/files/sign/post/`
 * — cannot import) and the mock's re-implementation inline in `handlers.ts`'s
 * `/api/workflow/files/sign` handler. `new Function` is test-only tooling to
 * execute the authored `.fn.js` source in isolation; it is never used by the
 * app or the mock at runtime.
 *
 * Unlike `analyze.fn.js`, this rule lives in this repo (not staged from
 * `bffless/workflow-hello`), so there is no `describe.skipIf` here.
 *
 * The mock does not expose its path predicate as a standalone helper — it's
 * inline in the `http.post` handler body — so this table drives both sides:
 * the raw `handler()` call against `confine.fn.js`, and an actual request to
 * the mock's `/api/workflow/files/sign` endpoint, sharing one case table
 * between them.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

type ConfineResult = { ok: boolean; notOk: boolean; storagePath: string }
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

/**
 * `ok: true` cases carry the path `confine.fn.js` normalises *to* — used to
 * assert both the fn's `storagePath` and the mock's signed URL. `ok: false`
 * cases include the ones `handlers.test.ts`'s own refusal test already
 * covers (outside the `workflows/` prefix, traversal, a double slash, an
 * empty path) plus the normalisation-only cases only the rule and the mock
 * implement (leading `/`, an `/api/uploads/` prefix, a trailing `?query`).
 */
const CASES: { desc: string; path: unknown; ok: boolean; normalized?: string }[] = [
  {
    desc: 'a confined path',
    path: 'workflows/hello/interactive/runs/run_1/poster.svg',
    ok: true,
    normalized: 'workflows/hello/interactive/runs/run_1/poster.svg',
  },
  {
    desc: 'a leading slash is stripped',
    path: '/workflows/hello/x.png',
    ok: true,
    normalized: 'workflows/hello/x.png',
  },
  {
    desc: 'an api/uploads/ prefix is stripped',
    path: 'api/uploads/workflows/hello/x.png',
    ok: true,
    normalized: 'workflows/hello/x.png',
  },
  {
    desc: 'a leading slash and the /api/uploads/ prefix are both stripped',
    path: '/api/uploads/workflows/hello/x.png',
    ok: true,
    normalized: 'workflows/hello/x.png',
  },
  {
    desc: 'a trailing ?query is dropped',
    path: 'workflows/hello/x.png?foo=bar',
    ok: true,
    normalized: 'workflows/hello/x.png',
  },
  { desc: 'outside the harness prefix', path: 'uploads/other/x.svg', ok: false },
  { desc: 'a bare other/ path', path: 'other/x', ok: false },
  { desc: 'directory traversal', path: 'workflows/../secrets/x', ok: false },
  { desc: 'a double slash', path: 'workflows//x', ok: false },
  { desc: 'an empty path', path: '', ok: false },
  { desc: 'a non-string path', path: undefined, ok: false },
]

describe('confine.fn.js parity with the mock re-implementation', () => {
  let handler: ConfineHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  it.each(CASES)('confine.fn.js: $desc', ({ path, ok, normalized }) => {
    const result = handler({ request: { body: { path } }, deployment: DEPLOYMENT })
    expect(result.ok).toBe(ok)
    expect(result.notOk).toBe(!ok)
    expect(result.storagePath).toBe(ok ? `${DEPLOYMENT.owner}/${DEPLOYMENT.repo}/uploads/${normalized}` : '')
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
