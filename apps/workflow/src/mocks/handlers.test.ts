/**
 * The mock backend is a stand-in for the harness rule set (Task 1), so it is
 * held to the same request/response contract: the write surface of 05 (create,
 * patch whitelist, step upsert, the lease gate), the files trio of 06, and the
 * hello pipelines the M1 implementation calls.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MOCK_ADMIN, MOCK_MEMBER, db, filesUnder, seedFinishedRun, setMockUser, stepsOf } from './db'
import { FINISHED_RUN } from './fixtures/finishedRun'
import { PAYLOAD_BUDGET_BYTES } from '../lib/runner/payload'

const json = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const RUN_ID = FINISHED_RUN.run.runId

describe('discovery — aliases scoping (apps#363)', () => {
  it('answers every alias when no ?repository= is given', async () => {
    const res = await fetch('/api/workflow/aliases')
    const aliases = (await res.json()) as { name: string }[]
    expect(aliases.map((a) => a.name).sort()).toEqual(['hello', 'workflow'])
  })

  it('answers the same list scoped to the mock project', async () => {
    const res = await fetch('/api/workflow/aliases?repository=bffless%2Fworkflow')
    const aliases = (await res.json()) as { name: string }[]
    expect(aliases.map((a) => a.name).sort()).toEqual(['hello', 'workflow'])
  })

  it('answers an empty list for an unknown repository', async () => {
    const res = await fetch('/api/workflow/aliases?repository=someone%2Felse')
    expect(await res.json()).toEqual([])
  })
})

describe('the run record surface', () => {
  beforeEach(() => {
    seedFinishedRun()
  })

  it('creates a run from the full row the client sends', async () => {
    const row = { ...FINISHED_RUN.run, runId: 'run_new', status: 'running', finishedAt: null }
    const res = await json('/api/workflow/runs', row)

    expect(res.status).toBe(200)
    const list = await (await fetch('/api/workflow/runs?impl=hello&workflow=hello')).json()
    expect(list.records.map((r: { runId: string }) => r.runId)).toContain('run_new')
    // `startedBy` is the *session's* member, not the body's — and the session is
    // whoever `setMockUser` last selected, so ownership is testable (Task 19).
    expect(list.records.find((r: { runId: string }) => r.runId === 'run_new').startedBy).toBe(MOCK_MEMBER.id)
  })

  it('patches only the patchable columns and 404s an unknown run', async () => {
    await json('/api/workflow/run/update', {
      id: RUN_ID,
      patch: { status: 'cancelled', finishedAt: 99, impl: 'hijacked' },
    })

    const { run } = await (await fetch(`/api/workflow/run?id=${RUN_ID}`)).json()
    expect(run.status).toBe('cancelled')
    expect(run.finishedAt).toBe(99)
    expect(run.impl).toBe('hello')

    const missing = await json('/api/workflow/run/update', { id: 'run_nope', patch: { status: 'failed' } })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('upserts a step row, merging the patch onto what is there', async () => {
    await json('/api/workflow/run-step', {
      runId: RUN_ID,
      key: 'greet/2/say',
      patch: { job: 'greet', index: 2, step: 'say', kind: 'pipeline', status: 'queued', attempt: 1 },
    })
    await json('/api/workflow/run-step', {
      runId: RUN_ID,
      key: 'greet/2/say',
      patch: { status: 'succeeded', outputs: { line: 'Hello, reader!' }, finishedAt: 5 },
    })

    const { steps } = await (await fetch(`/api/workflow/run?id=${RUN_ID}`)).json()
    const row = steps.find((s: { key: string }) => s.key === 'greet/2/say')
    expect(row).toMatchObject({
      job: 'greet',
      index: 2,
      kind: 'pipeline',
      status: 'succeeded',
      outputs: { line: 'Hello, reader!' },
      finishedAt: 5,
    })
  })

  it('gates the lease the way gate.fn.js does', async () => {
    const first = await (await json('/api/workflow/run/lease', { id: RUN_ID, owner: 'tab-a' })).json()
    expect(first.ok).toBe(true)
    expect(first.leaseUntil).toBeGreaterThan(Date.now())

    const held = await (await json('/api/workflow/run/lease', { id: RUN_ID, owner: 'tab-b' })).json()
    expect(held).toMatchObject({ ok: false, heldBy: 'tab-a' })

    const forced = await (await json('/api/workflow/run/lease', { id: RUN_ID, owner: 'tab-b', takeover: true })).json()
    expect(forced.ok).toBe(true)

    const unknown = await (await json('/api/workflow/run/lease', { id: 'run_nope', owner: 'tab-a' })).json()
    expect(unknown).toMatchObject({ ok: false, error: 'run not found' })
  })

  it('grants an expired lease to the next tab', async () => {
    await json('/api/workflow/run/lease', { id: RUN_ID, owner: 'tab-a' })
    await json('/api/workflow/run/update', { id: RUN_ID, patch: { leaseUntil: Date.now() - 1 } })

    const res = await (await json('/api/workflow/run/lease', { id: RUN_ID, owner: 'tab-b' })).json()
    expect(res.ok).toBe(true)
  })
})

/** The run whose rows the fixture seeds; `user_fixture` started it, not the default member. */
const OWNER = FINISHED_RUN.run.startedBy!
const RUN_PREFIX = `workflows/hello/hello/runs/${RUN_ID}/`
const INPUT_KEY = 'workflows/hello/hello/inputs/photo.png'

/** Bytes a real run leaves behind: two under its run prefix, one kickoff input outside it (D18). */
function seedBytes(): void {
  const file = { bytes: new Uint8Array([1]), contentType: 'application/octet-stream' }
  db.files.set(`${RUN_PREFIX}slow/0/start/poster.png`, file)
  db.files.set(`${RUN_PREFIX}outputs/report.json`, file)
  db.files.set(INPUT_KEY, file)
}

describe('run deletion (rows + file-prefix GC)', () => {
  beforeEach(() => {
    seedFinishedRun()
    seedBytes()
  })

  it('404s an unknown run', async () => {
    const res = await json('/api/workflow/run/delete', { id: 'run_nope' })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'run not found' })
  })

  it('refuses a run another member started (403) and deletes nothing', async () => {
    const res = await json('/api/workflow/run/delete', { id: RUN_ID })

    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('only the run owner or an admin can delete a run')
    expect(db.runs.has(RUN_ID)).toBe(true)
    expect(filesUnder(RUN_PREFIX)).toHaveLength(2)
  })

  it('refuses while the run is still running (409) — cancel is the way out', async () => {
    setMockUser({ ...MOCK_MEMBER, id: OWNER })
    await json('/api/workflow/run/update', { id: RUN_ID, patch: { status: 'running' } })

    const res = await json('/api/workflow/run/delete', { id: RUN_ID })

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('cancel the run first')
    expect(db.runs.has(RUN_ID)).toBe(true)
    expect(stepsOf(RUN_ID).length).toBeGreaterThan(0)
  })

  it('deletes the rows and the run prefix for its owner, keeping the kickoff inputs', async () => {
    setMockUser({ ...MOCK_MEMBER, id: OWNER })

    const res = await json('/api/workflow/run/delete', { id: RUN_ID })

    expect(res.status).toBe(200)
    // `records` is the workflow_files sweep's count — reported so a filter that
    // silently stops matching shows up as `records: 0` beside a non-zero `files`.
    expect(await res.json()).toEqual({ ok: true, deleted: { files: 2, records: 2 } })
    expect(db.runs.has(RUN_ID)).toBe(false)
    expect(stepsOf(RUN_ID)).toEqual([])
    expect(filesUnder(RUN_PREFIX)).toEqual([])
    expect(db.files.has(INPUT_KEY)).toBe(true)
  })

  // Final review, finding 4: `undefined !== undefined` is `false` — an
  // id-less caller (`function_handler` could not resolve one to a person)
  // must never fall through the ownership comparison just because a row
  // written before `startedBy` existed is *also* id-less. Mirrors
  // `run/delete/post/gate.fn.js`'s `!caller.id ||` guard.
  it('refuses an id-less caller even when the row also has no startedBy (403, not a false-positive match)', async () => {
    const row = { ...db.runs.get(RUN_ID)! }
    delete row.startedBy
    db.runs.set(RUN_ID, row)
    setMockUser({ ...MOCK_MEMBER, id: '' })

    const res = await json('/api/workflow/run/delete', { id: RUN_ID })

    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('only the run owner or an admin can delete a run')
    expect(db.runs.has(RUN_ID)).toBe(true)
  })

  it('lets an admin delete a run they did not start', async () => {
    setMockUser(MOCK_ADMIN)

    const res = await json('/api/workflow/run/delete', { id: RUN_ID })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, deleted: { files: 2, records: 2 } })
    expect(db.runs.has(RUN_ID)).toBe(false)
    expect(filesUnder(RUN_PREFIX)).toEqual([])
  })
})

describe('whoami', () => {
  it('answers the session member, uncacheable', async () => {
    const res = await fetch('/api/workflow/whoami')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual(MOCK_MEMBER)
  })

  it('answers the admin identity the mock switch selects (?as=admin)', async () => {
    setMockUser(MOCK_ADMIN)

    expect(await (await fetch('/api/workflow/whoami')).json()).toEqual(MOCK_ADMIN)
  })
})

describe('the files trio', () => {
  it('prepares, uploads, registers and serves', async () => {
    const prepared = await (
      await json('/api/workflow/files/prepare', {
        impl: 'hello',
        workflow: 'hello',
        scope: 'inputs/u1',
        filename: 'cat.png',
      })
    ).json()
    expect(prepared.storageKey).toBe('workflows/hello/hello/inputs/u1/cat.png')
    expect(prepared.uploadUrl).toBe('/mock-upload/workflows/hello/hello/inputs/u1/cat.png')

    const put = await fetch(prepared.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3, 4]),
    })
    expect(put.status).toBe(200)

    const ref = await (
      await json('/api/workflow/files/register', {
        impl: 'hello',
        workflow: 'hello',
        scope: 'inputs/u1',
        storageKey: prepared.storageKey,
        originalName: 'cat.png',
      })
    ).json()
    expect(ref).toEqual({
      path: 'workflows/hello/hello/inputs/u1/cat.png',
      name: 'cat.png',
      contentType: 'image/png',
      size: 4,
      url: '/api/uploads/workflows/hello/hello/inputs/u1/cat.png',
    })

    const served = await fetch(ref.url)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))

    expect((await fetch('/api/uploads/workflows/hello/nope.png')).status).toBe(404)
  })
})

describe('the script module route', () => {
  it('serves a bundle script as JavaScript, and 404s anything else', async () => {
    const res = await fetch('/w/hello/scripts/poster-card.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    // The text the harness turns into a Blob URL: a module with a default
    // export, not an HTML error page answered with a 200.
    expect(await res.text()).toContain('export default async function run')

    expect((await fetch('/w/hello/scripts/nope.js')).status).toBe(404)
    // Only `hello` publishes a bundle — another alias is an ordinary deploy.
    expect((await fetch('/w/workflow/scripts/poster-card.js')).status).toBe(404)
  })

  it('lists the staged scripts in the discovery index', async () => {
    const index = await (await fetch('/w/hello/.bffless/workflows/index.json')).json()
    expect(index.scripts).toEqual(['scripts/poster-card.js'])
  })

  /**
   * `poster-card`'s `big` output exists to push the step's outputs over the
   * `{"$file"}` budget (Decision 5) — the live `interactive` run and its e2e
   * assertion both depend on the offload actually firing. The count was cut
   * from 20 000 to 12 000 (the final whole-branch review's I4: ~100k DOM nodes
   * on the run page), so the budget is now pinned here rather than assumed.
   */
  it('returns a `big` output that is still over the payload budget', async () => {
    // Loaded through `import.meta.glob`, the way `handlers.ts` reads the same
    // directory: the script is plain JS with no declaration file, so a static
    // import specifier would not type-check.
    const modules = import.meta.glob('../../hello-src/scripts/poster-card.js') as Record<
      string,
      () => Promise<{ default: (ctx: unknown) => Promise<{ big: unknown[] }> }>
    >
    const load = Object.values(modules)[0]
    const outputs = await (await load()).default({
      inputs: { line: 'x', counts: [] },
      log: () => {},
      annotate: () => {},
      files: { fetch: () => Promise.reject(new Error('not used')) },
      signal: new AbortController().signal,
    })

    expect(outputs.big).toHaveLength(12000)
    // The worst case: a one-character line. Anything real is far larger.
    expect(JSON.stringify(outputs.big).length).toBeGreaterThan(PAYLOAD_BUDGET_BYTES)
  })
})

describe('the hello pipelines', () => {
  it('echoes, and shouts when asked', async () => {
    const plain = await (await json('/api/hello/echo', { text: 'Hello, world!' })).json()
    expect(plain).toEqual({ text: 'Hello, world!' })

    const loud = await (await json('/api/hello/echo', { text: 'Hello, world!', upper: true })).json()
    expect(loud).toEqual({ text: 'HELLO, WORLD!' })
  })

  it('is BUSY once per body, then enqueues a job that finishes on the second poll (R7)', async () => {
    const body = { lines: ['Hello, world!'], photo: null, outPrefix: 'workflows/hello/hello/runs/r/slow/0/start' }

    const busy = await json('/api/hello/slow', body)
    expect(busy.status).toBe(503)
    expect(await busy.json()).toMatchObject({ code: 'BUSY' })

    const enqueued = await (await json('/api/hello/slow', body)).json()
    expect(typeof enqueued.jobId).toBe('string')

    const pending = await (await fetch(`/api/hello/job?id=${enqueued.jobId}`)).json()
    // No `id` on the first tick (that is what makes the poll read the initial
    // response); `found: true` mirrors the real rule's `shape.fn.js` 200 body.
    expect(pending).toEqual({ found: true, status: 'pending' })

    const done = await (await fetch(`/api/hello/job?id=${enqueued.jobId}`)).json()
    expect(done).toMatchObject({
      id: enqueued.jobId,
      status: 'done',
      result: { posterPath: null, ms: 1234 },
    })
    expect(done.result.markdown).toContain('Hello, world!')
  })

  // M1 minor (a): the job poll 404s an unknown id the same way the real
  // rule's `notFound` response_handler does (condition: steps.shape.missing).
  it('404s an unknown job id', async () => {
    const res = await fetch('/api/hello/job?id=job_nope')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ status: 'error', error: 'unknown job' })
  })

  it('fails on purpose with the code it was handed', async () => {
    const res = await json('/api/hello/fail', { code: 'TEAPOT' })
    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ code: 'TEAPOT', error: 'fails on purpose' })
  })

  it('defaults the fail code to FAIL when none is given', async () => {
    const res = await json('/api/hello/fail', {})
    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ code: 'FAIL', error: 'fails on purpose' })
  })

  // No string interpolation of request data (M1 minor b) — a code value that
  // would break naive JSON-string templating comes back as the literal string.
  it('fails on purpose with an unescaped code, verbatim', async () => {
    const res = await json('/api/hello/fail', { code: '"}evil' })
    expect(res.status).toBe(418)
    expect(await res.json()).toEqual({ code: '"}evil', error: 'fails on purpose' })
  })

  it('analyzes lines into words, a chart-shaped count table, a snippet and the longest line', async () => {
    const res = await json('/api/hello/analyze', { lines: ['Hello, world!'] })
    expect(res.status).toBe(200)
    const out = await res.json()

    expect(out.words).toHaveLength(2)
    expect(out.words[0]).toEqual({ text: 'Hello,', start: 0, end: 0.4 })
    expect(out.words[1]).toEqual({ text: 'world!', start: 0.4, end: 0.8 })

    expect(out.counts.columns).toEqual([{ key: 'line' }, { key: 'chars', type: 'number' }])
    expect(out.counts.rows[0]).toEqual({ line: 'Hello, world!', chars: 13 })

    expect(out.snippet).toContain('Hello, world!')
    expect(out.longest).toBe('Hello, world!')
  })

  it('analyzes an empty/non-array lines value into empty output', async () => {
    const res = await json('/api/hello/analyze', { lines: 'not-an-array' })
    const out = await res.json()
    expect(out).toEqual({
      words: [],
      counts: { columns: [{ key: 'line' }, { key: 'chars', type: 'number' }], rows: [] },
      snippet: 'export const lines = []',
      longest: '',
    })
  })
})

describe('resetDb', () => {
  it('leaves no rows behind between tests', () => {
    expect(db.runs.size).toBe(0)
    expect(db.steps.size).toBe(0)
    expect(db.files.size).toBe(0)
  })
})
