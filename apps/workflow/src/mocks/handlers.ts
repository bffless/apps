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
import helloYaml from '../../docs/spec/examples/hello.workflow.yaml?raw'

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

const helloDefinition = loadWorkflow(helloYaml, 'hello.workflow.yaml').def
if (!helloDefinition) throw new Error('mock handlers: the hello workflow no longer parses')

/**
 * `index.json` as the implementation's CI would have generated it — counted off
 * the real definition so the listing can never drift from the YAML it describes.
 */
const HELLO_INDEX = {
  spec: 1,
  impl: 'hello',
  name: 'Hello',
  version: '0.0.0',
  commit: 'mock',
  generatedAt: '2026-08-19T12:00:00.000Z',
  workflows: [
    {
      file: 'hello.workflow.yaml',
      name: helloDefinition.name,
      description: helloDefinition.raw.description,
      inputs: Object.keys(helloDefinition.inputs).length,
      jobs: Object.keys(helloDefinition.jobs).length,
      headlessSafe: true,
    },
  ],
  islands: [],
  scripts: [],
}

const discovery = [
  http.get('/api/aliases', () => HttpResponse.json(ALIASES)),

  // Only `hello` publishes workflows; every other alias 404s, which is exactly
  // how the harness tells an implementation from an ordinary deploy (ADR-0004).
  http.get('/w/:alias/.bffless/workflows/index.json', ({ params }) =>
    params.alias === 'hello' ? HttpResponse.json(HELLO_INDEX) : new HttpResponse(null, { status: 404 }),
  ),

  http.get('/w/:alias/.bffless/workflows/:file', ({ params }) =>
    params.alias === 'hello' && params.file === 'hello.workflow.yaml'
      ? HttpResponse.text(helloYaml, { headers: { 'content-type': 'text/yaml' } })
      : new HttpResponse(null, { status: 404 }),
  ),
]

// ---------------------------------------------------------------------------
// The run record (05)
// ---------------------------------------------------------------------------

/** Patchable post-create; everything else is the immutable start snapshot (D16). */
const RUN_PATCHABLE = ['status', 'finishedAt', 'leaseOwner', 'leaseUntil', 'outputs', 'annotations']

const LEASE_MS = 60_000

/** A step row as `merge.fn.js` invents it when the upsert is the first write. */
function baseStepRow(runId: string, key: string): ServerStepRow {
  return toStepRow({ runId, key })
}

const runRecord = [
  // The client sends the whole row; `startedBy` is the session's, not the body's.
  http.post('/api/workflow/runs', async ({ request }) => {
    const row = toRunRow(await body(request))
    const stored = { ...row, startedBy: row.startedBy ?? 'user_mock', _id: nextId() }
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
  // query-then-write is race-safe in practice.
  http.post('/api/workflow/run-step', async ({ request }) => {
    const { runId, key, patch } = await body(request)
    const id = stepRowKey(String(runId), String(key))
    const existing = db.steps.get(id)
    const merged = {
      ...(existing ?? baseStepRow(String(runId), String(key))),
      ...obj(patch),
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

  // The serve rule reads the `workflows/` prefix off the storage path, so the
  // route is the path minus that prefix (see `fileUrl`).
  http.get('/api/workflow/files/*', ({ params }) => {
    const stored = db.files.get(`workflows/${decodeURIComponent(String(params['0'] ?? ''))}`)
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
  // response rather than the tick's (01 contexts).
  http.get('/api/hello/job', ({ request }) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const job = db.helloJobs.get(id)
    if (!job) return HttpResponse.json({ status: 'error', error: 'unknown job' }, { status: 404 })
    job.polls += 1
    if (job.polls < 2) return HttpResponse.json({ status: 'pending' })
    return HttpResponse.json({ id, status: 'done', result: job.result })
  }),

  http.post('/api/hello/fail', async ({ request }) => {
    const { code } = await body(request)
    return HttpResponse.json({ code: String(code ?? 'FAILED'), error: 'fails on purpose' }, { status: 418 })
  }),
]

// ---------------------------------------------------------------------------
// Auth — the SuperTokens refresh relay the data layer retries through (R5)
// ---------------------------------------------------------------------------

const auth = [http.post('/api/auth/session/refresh', () => new HttpResponse(null, { status: 200 }))]

export const handlers = [...discovery, ...runRecord, ...files, ...hello, ...auth]
