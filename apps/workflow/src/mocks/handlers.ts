/**
 * The mock backend: the harness rule set (Task 1) and the `hello`
 * implementation, in the browser (dev) and in node (tests).
 *
 * It is a *stand-in*, not a sketch — every handler answers the request/response
 * shape its rule answers, envelopes included, because the app talks to both
 * through the same coercers (09). When a rule changes, this file changes with
 * it; a divergence here is a bug that only shows up in production.
 *
 * Sections: discovery (06) · the run record (05) · the files trio (06) ·
 * the hello pipelines · auth.
 */
import { http, HttpResponse } from 'msw'
import { toFileRef, toRunRow, toStepRow } from '../lib/coerce'
import type { ServerStepRow } from '../lib/coerce'
import { loadWorkflow } from '../lib/runner/definition'
import { db, nextId, stepRowKey, stepsOf, toRecord } from './db'
import { analyzeLines } from './analyze'
import helloYaml from '../../docs/spec/examples/hello.workflow.yaml?raw'
import interactiveYaml from '../../docs/spec/examples/interactive.workflow.yaml?raw'

const ok = () => HttpResponse.json({ ok: true })

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

async function body(request: Request): Promise<Record<string, unknown>> {
  return obj(await request.json().catch(() => ({})))
}

// ---------------------------------------------------------------------------
// Discovery (06) — a deploy is the publish
// ---------------------------------------------------------------------------

/** The aliases of the mock project: the harness itself, and one implementation. */
const ALIASES = [
  { name: 'workflow', isAutoPreview: false },
  { name: 'hello', isAutoPreview: false },
]

/** The workflow files this mock implementation publishes, exactly as the bundle does. */
const HELLO_WORKFLOWS: Record<string, string> = {
  'hello.workflow.yaml': helloYaml,
  'interactive.workflow.yaml': interactiveYaml,
}

/**
 * The staged islands, read straight out of `hello-dist/` — the same bytes the
 * deploy uploads. Empty until `pnpm --filter workflow stage` has run (the
 * route then 404s, which is exactly what an unstaged bundle would do), so CI
 * stages before it tests.
 */
const ISLAND_HTML: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../hello-dist/islands/*.html', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, html]) => [path.split('/').pop()!, html]),
)

function definitionOf(file: string) {
  const def = loadWorkflow(HELLO_WORKFLOWS[file]!, file).def
  if (!def) throw new Error(`mock handlers: ${file} no longer parses`)
  return def
}

/**
 * `index.json` as the implementation's CI would have generated it — counted off
 * the real definitions so the listing can never drift from the YAMLs it
 * describes. Exported so `hello-stage.test.ts` can assert the staged bundle's
 * counts never drift from this mock's (Task 20 parity test).
 */
export const HELLO_INDEX = {
  spec: 1,
  impl: 'hello',
  name: 'Hello',
  version: '0.0.0',
  commit: 'mock',
  generatedAt: '2026-08-19T12:00:00.000Z',
  workflows: Object.keys(HELLO_WORKFLOWS).map((file) => {
    const def = definitionOf(file)
    return {
      file,
      name: def.name,
      description: def.raw.description,
      inputs: Object.keys(def.inputs).length,
      jobs: Object.keys(def.jobs).length,
      headlessSafe: true,
    }
  }),
  // Derived from the same glob the island route serves, so an unstaged dev
  // session lists no islands rather than two that would 404. Glob order (by
  // path), not the stager's listing order — the parity test compares sets.
  islands: Object.keys(ISLAND_HTML).sort().map((name) => `islands/${name}`),
  scripts: [],
}

const discovery = [
  http.get('/api/workflow/aliases', () => HttpResponse.json(ALIASES)),

  // Only `hello` publishes workflows; every other alias 404s, which is exactly
  // how the harness tells an implementation from an ordinary deploy (ADR-0004).
  http.get('/w/:alias/.bffless/workflows/index.json', ({ params }) =>
    params.alias === 'hello' ? HttpResponse.json(HELLO_INDEX) : new HttpResponse(null, { status: 404 }),
  ),

  http.get('/w/:alias/.bffless/workflows/:file', ({ params }) => {
    const yaml = params.alias === 'hello' ? HELLO_WORKFLOWS[String(params.file)] : undefined
    return yaml === undefined
      ? new HttpResponse(null, { status: 404 })
      : HttpResponse.text(yaml, { headers: { 'content-type': 'text/yaml' } })
  }),

  // The island files, served the way the bundle alias serves them: the harness
  // fetches this with the member's session and injects the text as `srcdoc`
  // (Decision 9), so the response is `text/html` and nothing else.
  http.get('/w/:alias/islands/:name', ({ params }) => {
    const html = params.alias === 'hello' ? ISLAND_HTML[String(params.name)] : undefined
    return html === undefined
      ? new HttpResponse(null, { status: 404 })
      : HttpResponse.text(html, { headers: { 'content-type': 'text/html' } })
  }),
]

// ---------------------------------------------------------------------------
// The run record (05)
// ---------------------------------------------------------------------------

/** Patchable post-create; everything else is the immutable start snapshot (D16). */
const RUN_PATCHABLE = ['status', 'finishedAt', 'leaseOwner', 'leaseUntil', 'outputs', 'annotations']

/** The 11 mutable step columns (05); `job`/`index`/`step`/`kind` are create-only. */
const STEP_MUTABLE = [
  'status', 'attempt', 'inputs', 'response', 'outputs', 'error', 'summary',
  'annotations', 'startedAt', 'finishedAt', 'heartbeatAt',
]
const STEP_IDENTITY = ['job', 'index', 'step', 'kind']

const LEASE_MS = 60_000

/** A step row as `merge.fn.js` invents it when the upsert is the first write. */
function baseStepRow(runId: string, key: string): ServerStepRow {
  return toStepRow({ runId, key })
}

function pick(fields: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const column of columns) if (column in fields) out[column] = fields[column]
  return out
}

const runRecord = [
  // The client sends the whole row, but `startedBy` is the *session's*, never
  // the body's — the real rule stamps it server-side (05 access: "started_by
  // is recorded"), so a client-supplied value must never be trusted.
  http.post('/api/workflow/runs', async ({ request }) => {
    const row = toRunRow(await body(request))
    const stored = { ...row, startedBy: 'user_mock', _id: nextId() }
    db.runs.set(stored.runId, stored)
    return HttpResponse.json(toRecord(stored))
  }),

  // The rule answers with the raw `data_query` result — envelope and all.
  http.get('/api/workflow/runs', ({ request }) => {
    const url = new URL(request.url)
    const impl = url.searchParams.get('impl')
    const workflow = url.searchParams.get('workflow')
    const records = [...db.runs.values()]
      .filter((row) => (impl === null || row.impl === impl) && (workflow === null || row.workflow === workflow))
      .map(toRecord)
    return HttpResponse.json({ records }, { headers: { 'Cache-Control': 'no-store' } })
  }),

  http.get('/api/workflow/run', ({ request }) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const run = db.runs.get(id)
    return HttpResponse.json(
      { run: run ? toRecord(run) : null, steps: stepsOf(id).map(toRecord) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }),

  http.post('/api/workflow/run/update', async ({ request }) => {
    const { id, patch } = await body(request)
    const run = db.runs.get(String(id))
    if (!run) {
      return HttpResponse.json({ error: 'run not found', code: 'NOT_FOUND' }, { status: 404 })
    }
    const fields = obj(patch)
    const merged = { ...run }
    for (const column of RUN_PATCHABLE) {
      if (column in fields) Object.assign(merged, { [column]: fields[column] })
    }
    db.runs.set(merged.runId, merged)
    return ok()
  }),

  // Read-merge-write on (runId, key) — the lease serialises writers, so a plain
  // query-then-write is race-safe in practice. Mirrors the real rule's column
  // list: only the 11 mutable step columns are ever patched; `job`/`index`/
  // `step`/`kind` are identity, set once on the row's first write.
  http.post('/api/workflow/run-step', async ({ request }) => {
    const { runId, key, patch } = await body(request)
    const id = stepRowKey(String(runId), String(key))
    const existing = db.steps.get(id)
    const fields = obj(patch)
    const merged = {
      ...(existing ?? { ...baseStepRow(String(runId), String(key)), ...pick(fields, STEP_IDENTITY) }),
      ...pick(fields, STEP_MUTABLE),
      runId: String(runId),
      key: String(key),
      _id: existing?._id ?? nextId(),
    }
    db.steps.set(id, merged)
    return ok()
  }),

  // Mirrors `gate.fn.js`: granted when unheld, expired, already ours, or forced.
  http.post('/api/workflow/run/lease', async ({ request }) => {
    const { id, owner, takeover } = await body(request)
    const run = db.runs.get(String(id))
    if (!run) return HttpResponse.json({ ok: false, error: 'run not found' })

    const now = Date.now()
    const held = Boolean(run.leaseOwner) && typeof run.leaseUntil === 'number' && run.leaseUntil > now
    if (held && run.leaseOwner !== owner && takeover !== true) {
      return HttpResponse.json({ ok: false, heldBy: run.leaseOwner, leaseUntil: run.leaseUntil })
    }

    const leaseUntil = now + LEASE_MS
    db.runs.set(run.runId, { ...run, leaseOwner: String(owner), leaseUntil })
    return HttpResponse.json({ ok: true, leaseUntil })
  }),
]

// ---------------------------------------------------------------------------
// The files trio (06) — the harness owns where bytes live
// ---------------------------------------------------------------------------

const MOCK_UPLOAD_PREFIX = '/mock-upload/'

function storageKey(fields: Record<string, unknown>): string {
  return ['workflows', fields.impl, fields.workflow, fields.scope, fields.filename]
    .map((part) => String(part ?? '').replace(/^\/+|\/+$/g, ''))
    .filter((part) => part !== '')
    .join('/')
}

const files = [
  http.post('/api/workflow/files/prepare', async ({ request }) => {
    const key = storageKey(await body(request))
    return HttpResponse.json({ uploadUrl: `${MOCK_UPLOAD_PREFIX}${key}`, storageKey: key })
  }),

  // Stands in for the direct-to-bucket PUT: the bytes never leave the process.
  http.put(`${MOCK_UPLOAD_PREFIX}*`, async ({ request }) => {
    const key = decodeURIComponent(new URL(request.url).pathname.slice(MOCK_UPLOAD_PREFIX.length))
    db.files.set(key, {
      bytes: new Uint8Array(await request.arrayBuffer()),
      contentType: request.headers.get('content-type') ?? 'application/octet-stream',
    })
    return new HttpResponse(null, { status: 200 })
  }),

  http.post('/api/workflow/files/register', async ({ request }) => {
    const fields = await body(request)
    const key = String(fields.storageKey ?? '')
    const stored = db.files.get(key)
    return HttpResponse.json(
      toFileRef({
        path: key,
        name: fields.originalName,
        contentType: stored?.contentType,
        size: stored?.bytes.byteLength ?? 0,
      }),
    )
  }),

  // The serve rule is CE's file_serve_handler at /api/uploads/<subDir>/…, so the
  // route is the uploads-relative storage path itself (see `fileUrl`).
  http.get('/api/uploads/*', ({ params }) => {
    const stored = db.files.get(decodeURIComponent(String(params['0'] ?? '')))
    if (!stored) return new HttpResponse(null, { status: 404 })
    return new HttpResponse(stored.bytes, { headers: { 'content-type': stored.contentType } })
  }),
]

// ---------------------------------------------------------------------------
// The hello pipelines — what the M1 test implementation's API does
// ---------------------------------------------------------------------------

const hello = [
  http.post('/api/hello/echo', async ({ request }) => {
    const { text, upper } = await body(request)
    const value = String(text ?? '')
    return HttpResponse.json({ text: upper === true ? value.toUpperCase() : value })
  }),

  // One BUSY per distinct body, so the `retry.if: error.code == 'BUSY'` branch
  // is exercised on every fresh run without ever failing the step (R7).
  http.post('/api/hello/slow', async ({ request }) => {
    const fields = await body(request)
    const signature = JSON.stringify(fields)
    if (!db.helloBusy.has(signature)) {
      db.helloBusy.add(signature)
      return HttpResponse.json({ code: 'BUSY', error: 'the hello service is busy' }, { status: 503 })
    }

    const lines = Array.isArray(fields.lines) ? fields.lines.map(String) : []
    const jobId = nextId('job')
    db.helloJobs.set(jobId, {
      polls: 0,
      result: {
        markdown: `## Hello report\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`,
        posterPath: typeof fields.photo === 'string' ? fields.photo : null,
        ms: 1234,
      },
    })
    return HttpResponse.json({ jobId })
  }),

  // The first tick is `pending` and does NOT echo the id — that is what makes
  // the poll's `query: { id: ${{ response.jobId }} }` read the *initial*
  // response rather than the tick's (01 contexts). 404 mirrors the real
  // rule's `notFound` response_handler (condition: steps.shape.missing —
  // M1 minor a).
  http.get('/api/hello/job', ({ request }) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const job = db.helloJobs.get(id)
    if (!job) return HttpResponse.json({ status: 'error', error: 'unknown job' }, { status: 404 })
    // `found: true` is what the real rule's `shape.fn.js` sets for its 200
    // branch (the `respond` responder's condition); nothing reads it, but the
    // two bodies carry the same keys.
    job.polls += 1
    if (job.polls < 2) return HttpResponse.json({ found: true, status: 'pending' })
    return HttpResponse.json({ found: true, id, status: 'done', result: job.result })
  }),

  // The real rule builds this body via a `function_handler` (`fail.fn.js`), not
  // string interpolation of `request.body.code` (M1 minor b) — a `code` value
  // that would break naive JSON-string templating comes back verbatim here too.
  http.post('/api/hello/fail', async ({ request }) => {
    const { code } = await body(request)
    return HttpResponse.json({ code: String(code ?? 'FAIL'), error: 'fails on purpose' }, { status: 418 })
  }),

  // POST { lines, code? } -> { words, counts, snippet, longest }. Mirrors
  // `analyze.fn.js` byte-for-byte (see analyze.ts and its parity test).
  http.post('/api/hello/analyze', async ({ request }) => {
    const { lines } = await body(request)
    return HttpResponse.json(analyzeLines(lines))
  }),
]

// ---------------------------------------------------------------------------
// Auth — the SuperTokens refresh relay the data layer retries through (R5)
// ---------------------------------------------------------------------------

const auth = [http.post('/api/auth/session/refresh', () => new HttpResponse(null, { status: 200 }))]

export const handlers = [...discovery, ...runRecord, ...files, ...hello, ...auth]
