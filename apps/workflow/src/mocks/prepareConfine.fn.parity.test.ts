/**
 * Parity between `files/prepare`'s `confine.fn.js` (the real rule's standalone
 * `function_handler` code, at
 * `.bffless/proxy-rules/workflow/rules/api/workflow/files/prepare/post/` —
 * cannot import) and the mock's re-implementation inline in `handlers.ts`'s
 * `/api/workflow/files/prepare` handler. `new Function` is test-only tooling
 * to execute the authored `.fn.js` source in isolation; it is never used by
 * the app or the mock at runtime.
 *
 * New for spec 11 (D29): before this task `files/prepare` validated nothing —
 * `confine.fn.js` and its 400 refusal, and the run locator/gate behind it, are
 * new surface, so this table exercises both from scratch rather than growing
 * an existing one (unlike `confine.fn.parity.test.ts`/`normalize.fn.parity.test.ts`).
 *
 * `scope` has no `workflows/<impl>/<workflow>/` head to strip — the rule
 * templates that ahead of it (`prepare`'s `subDir`) — so the grammar is just
 * `inputs`/`inputs/…` (D18, runless) or `runs/<runId>/<step>` (must name a
 * step after the id, not just the bare run).
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
  'workflow',
  'files',
  'prepare',
  'post',
  'confine.fn.js',
)

type ConfineResult = { ok: boolean; notOk: boolean; hasRun: boolean; runId: string; runless: boolean }
type ConfineHandler = (ctx: { request: { body: Record<string, unknown> } }) => ConfineResult

function loadFnHandler(): ConfineHandler {
  const src = readFileSync(FN_PATH, 'utf8')
  const factory = new Function(`${src}\nreturn handler;`)
  return factory()
}

const RUN_ID = 'run_1'

/**
 * `ok:true` rows carry `hasRun`/`runId`/`runless`; `ok:false` rows — traversal,
 * a double slash, a run id that does not fit `RUN_ID_PATTERN`, a bare `runs/<id>`
 * with no step after it, an unrecognised head, empty/non-string — are the
 * rule's `refuse` 400 and never reach a gate.
 */
const CASES: { desc: string; scope: unknown; ok: boolean; hasRun: boolean; runId: string; runless: boolean }[] = [
  { desc: 'a bare inputs scope', scope: 'inputs', ok: true, hasRun: false, runId: '', runless: true },
  { desc: 'an inputs/ subpath', scope: 'inputs/u1/cat.png', ok: true, hasRun: false, runId: '', runless: true },
  { desc: 'a run scope with a step', scope: `runs/${RUN_ID}/greet/0/say`, ok: true, hasRun: true, runId: RUN_ID, runless: false },
  { desc: 'a leading/trailing slash on a run scope is trimmed', scope: `/runs/${RUN_ID}/greet/0/say/`, ok: true, hasRun: true, runId: RUN_ID, runless: false },
  {
    // Fix round 1: see `confine.fn.parity.test.ts`'s equivalent row — the `runs`
    // segment matches case-insensitively, so `RUNS/…` is gated the same as `runs/…`.
    desc: 'the runs segment matches case-insensitively (RUNS)',
    scope: `RUNS/${RUN_ID}/greet/0/say`,
    ok: true,
    hasRun: true,
    runId: RUN_ID,
    runless: false,
  },
  { desc: 'a bare runs/<id> with no step is refused', scope: `runs/${RUN_ID}`, ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a malformed run id is refused', scope: 'runs/not-a-real-id/say', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'traversal in a run scope', scope: 'runs/../secrets/x', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'traversal in an inputs scope', scope: 'inputs/../secrets', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a double slash', scope: `runs/${RUN_ID}//say`, ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'an unrecognised head', scope: 'outputs/x', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'an empty scope', scope: '', ok: false, hasRun: false, runId: '', runless: false },
  { desc: 'a non-string scope', scope: undefined, ok: false, hasRun: false, runId: '', runless: false },
]

const prepare = (fields: Record<string, unknown>) =>
  fetch('/api/workflow/files/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ impl: 'hello', workflow: 'hello', filename: 'take.mov', ...fields }),
  })

describe("files/prepare's confine.fn.js parity with the mock re-implementation", () => {
  let handler: ConfineHandler

  beforeAll(() => {
    handler = loadFnHandler()
  })

  beforeEach(() => {
    // The one `hasRun` id every `ok:true` run-scoped row above names, owned by
    // the mock's default member (Decision 12) so the endpoint sub-test below
    // reaches the gate rather than refusing before it runs.
    db.runs.set(RUN_ID, { ...FINISHED_RUN.run, runId: RUN_ID, _id: nextId() })
  })

  it.each(CASES)('confine.fn.js: $desc', ({ scope, ok, hasRun, runId, runless }) => {
    // `impl`/`workflow` are valid single segments throughout this table — the
    // `IDENTIFIER_CASES` block below is what pins THEIR validation.
    const result = handler({ request: { body: { impl: 'hello', workflow: 'hello', scope } } })
    expect(result.ok).toBe(ok)
    expect(result.notOk).toBe(!ok)
    expect(result.hasRun).toBe(hasRun)
    expect(result.runId).toBe(runId)
    expect(result.runless).toBe(runless)
  })

  it.each(CASES)('mock /api/workflow/files/prepare: $desc', async ({ scope, ok }) => {
    const res = await prepare({ scope })
    expect(res.status).toBe(ok ? 200 : 400)
    if (ok) {
      const { storageKey } = await res.json()
      expect(typeof storageKey).toBe('string')
    } else {
      expect((await res.json()).error).toBe('scope must be inputs or runs/<runId>/<step>')
    }
  })

  /**
   * Fix round 1: `presigned_upload`'s `subDir` templates `workflows/{{impl}}/
   * {{workflow}}/{{scope}}` unvalidated, so a caller who controls `workflow`
   * (or `impl`) could otherwise plant bytes under another member's run prefix
   * — `workflow: "x/runs/run_VICTIM/step"` — without `scope` itself ever
   * naming that run. `confine.fn.js` now requires both to be a single path
   * segment; this pins the 400 on both sides for a `workflow` (and, for good
   * measure, an `impl`) that isn't one.
   */
  const IDENTIFIER_CASES: { desc: string; fields: Record<string, unknown> }[] = [
    { desc: 'a slash in workflow', fields: { workflow: 'x/runs/run_VICTIM/step' } },
    { desc: 'a slash in impl', fields: { impl: 'x/runs' } },
    { desc: 'traversal in workflow', fields: { workflow: '../other' } },
    { desc: 'an empty workflow', fields: { workflow: '' } },
  ]

  it.each(IDENTIFIER_CASES)('confine.fn.js: $desc → notOk', ({ fields }) => {
    const result = handler({ request: { body: { impl: 'hello', workflow: 'hello', scope: 'inputs', ...fields } } })
    expect(result.ok).toBe(false)
    expect(result.notOk).toBe(true)
  })

  it.each(IDENTIFIER_CASES)('mock /api/workflow/files/prepare: $desc → 400', async ({ fields }) => {
    const res = await prepare({ scope: 'inputs', ...fields })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('scope must be inputs or runs/<runId>/<step>')
  })
})

/**
 * The shared run gate (spec 11 D29), wired into `files/prepare` through
 * `confine.fn.js`'s `hasRun`/`runId`. Mirrors `runGate.endpoints.test.ts`'s
 * arrangement (Task B4): a fixture run owned by `MOCK_MEMBER`, `MOCK_OTHER` as
 * a member who did not start it.
 */
describe('files/prepare: run ownership (spec 11 D29)', () => {
  const OWNED_RUN_ID = 'run_owned00000000000000000000'
  const GHOST_ID = 'run_ghost0000000000000000000'

  beforeEach(() => {
    db.runs.set(OWNED_RUN_ID, { ...FINISHED_RUN.run, runId: OWNED_RUN_ID, _id: nextId() })
  })

  it('prepares an upload under the owner’s own run', async () => {
    setMockUser(MOCK_MEMBER)
    const res = await prepare({ scope: `runs/${OWNED_RUN_ID}/slow/0/start` })
    expect(res.status).toBe(200)
  })

  it('refuses an upload under another member’s run — 404, not 403 (D26)', async () => {
    setMockUser(MOCK_OTHER)
    const res = await prepare({ scope: `runs/${OWNED_RUN_ID}/slow/0/start` })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
  })

  it('prepares an inputs/ upload for any member — no runId, stays member-wide (D18)', async () => {
    setMockUser(MOCK_OTHER)
    const res = await prepare({ scope: 'inputs/u1' })
    expect(res.status).toBe(200)
  })

  it('refuses a runs/<id>/ scope whose run does not exist — 404', async () => {
    setMockUser(MOCK_MEMBER)
    const res = await prepare({ scope: `runs/${GHOST_ID}/slow/0/start` })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
  })

  it('refuses another member’s run even through an uppercase RUNS segment — 404 (fix round 1)', async () => {
    setMockUser(MOCK_OTHER)
    const res = await prepare({ scope: `RUNS/${OWNED_RUN_ID}/slow/0/start` })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
  })
})
