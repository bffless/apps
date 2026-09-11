/**
 * The mock backend: the harness rule set (Task 1) and the `hello`
 * implementation, in the browser (dev) and in node (tests).
 *
 * It is a *stand-in*, not a sketch — every handler answers the request/response
 * shape its rule answers, envelopes included, because the app talks to both
 * through the same coercers (09). When a rule changes, this file changes with
 * it; a divergence here is a bug that only shows up in production.
 *
 * Sections: discovery (06) · the run record (05) · the files quartet (06) ·
 * the hello pipelines · auth.
 */
import { http, HttpResponse } from 'msw'
import { toFileRef, toRunRow, toStepRow } from '../lib/coerce'
import type { ServerStepRow } from '../lib/coerce'
import { loadWorkflow } from '../lib/runner/definition'
import {
  db,
  deleteRun,
  mockUser,
  MOCK_UPLOADS_ROOT,
  nextId,
  registerFileRecord,
  stepRowKey,
  stepsOf,
  toRecord,
  waitingKeysOf,
} from './db'
import type { MockRunRow } from './db'
import { analyzeLines } from './analyze'
import { forkGate } from './forkGate'
import { DRIVE_KEY_HEADER, mockGate } from './runGate'
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

/**
 * The aliases of the mock project: the harness itself, and one implementation.
 * `repository` mirrors what the real relay filters `?repository=` against
 * (apps#363) — every mock alias lives in the same project, so an unscoped
 * probe and a `?repository=bffless/workflow`-scoped one see the same list;
 * only an unknown repository narrows it to nothing.
 */
const ALIASES = [
  { name: 'workflow', isAutoPreview: false, repository: 'bffless/workflow' },
  { name: 'hello', isAutoPreview: false, repository: 'bffless/workflow' },
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

/**
 * The scripts, read straight out of `hello-src/workflows/hello/scripts/` — the **source**
 * `stage-hello.mjs` clones from `bffless/workflow-implementations` and copies verbatim
 * into the bundle (a Worker fetches it as a module, so there is no build step
 * to mirror). Populated once `pnpm --filter workflow stage` has cloned the
 * implementation — like the island glob above, empty (and this route 404s)
 * before that.
 */
const SCRIPT_SOURCE: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob('../../hello-src/workflows/hello/scripts/*.js', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>,
  ).map(([path, source]) => [path.split('/').pop()!, source]),
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
  scripts: Object.keys(SCRIPT_SOURCE).sort().map((name) => `scripts/${name}`),
}

const discovery = [
  http.get('/api/workflow/aliases', ({ request }) => {
    const repository = new URL(request.url).searchParams.get('repository')
    const aliases = repository === null ? ALIASES : ALIASES.filter((a) => a.repository === repository)
    return HttpResponse.json(aliases)
  }),

  // The serving project (apps#363): what the `project` rule reads off CE's
  // `deployment` provenance root. The mock project is `bffless/workflow` — the
  // same repository every mock alias above carries, so a runtime-scoped probe
  // and an unscoped one see the same list here too.
  http.get('/api/workflow/project', () =>
    HttpResponse.json({ repository: 'bffless/workflow' }, { headers: NO_STORE }),
  ),

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

  // The script modules, served the way the bundle alias serves them: the
  // harness fetches this with the member's session and hands the text to the
  // sandbox frame, which mints the `data:` URL the Worker imports (03). So the
  // response must be JavaScript — an HTML error page with a 200 would be
  // imported as a module and fail obscurely.
  http.get('/w/:alias/scripts/:name', ({ params }) => {
    const source = params.alias === 'hello' ? SCRIPT_SOURCE[String(params.name)] : undefined
    return source === undefined
      ? new HttpResponse(null, { status: 404 })
      : HttpResponse.text(source, { headers: { 'content-type': 'text/javascript' } })
  }),
]

// ---------------------------------------------------------------------------
// The run record (05)
// ---------------------------------------------------------------------------

/** Patchable post-create; everything else is the immutable start snapshot (D16). */
const RUN_PATCHABLE = [
  'status', 'finishedAt', 'leaseOwner', 'leaseUntil', 'outputs', 'annotations', 'annotationCounts',
]

/** The 13 mutable step columns (05); `job`/`index`/`step`/`kind` are create-only. */
const STEP_MUTABLE = [
  'status', 'attempt', 'inputs', 'response', 'outputs', 'error', 'summary',
  'annotations', 'log', 'logId', 'startedAt', 'finishedAt', 'heartbeatAt',
]
const STEP_IDENTITY = ['job', 'index', 'step', 'kind']

const LEASE_MS = 60_000

const NO_STORE = { 'Cache-Control': 'no-store' }

/** One of a gated rule's literal-status `response_handler` refusals. */
const refuse = (status: number, error: string) =>
  HttpResponse.json({ ok: false, error }, { status, headers: NO_STORE })

/** A step row as `merge.fn.js` invents it when the upsert is the first write. */
function baseStepRow(runId: string, key: string): ServerStepRow {
  return toStepRow({ runId, key })
}

function pick(fields: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const column of columns) if (column in fields) out[column] = fields[column]
  return out
}

/**
 * An implementation alias, as `run/drive`'s `drivePlan.ts` fences it — the mock
 * re-states it rather than importing, the way every other mock re-implements
 * the rule it stands in for.
 */
const IMPL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/

/** A run in one of these is over (`lib/runner/types.ts` `RunStatus`); only a live run can be driven. */
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled']

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** One of `run/drive`'s coded 400s — the rule's single `refuse` responder. */
const drivenRefusal = (code: string, message: string) =>
  HttpResponse.json({ code, message }, { status: 400, headers: NO_STORE })

const RUN_EXISTS = () =>
  HttpResponse.json({ code: 'RUN_EXISTS', error: 'a run with this id already exists' }, { status: 409 })

const runRecord = [
  // The client sends the whole row, but ownership is never the body's — the
  // real rule's `admit.fn.js` decides it (spec 11 §Attribution, D28), and this
  // mirrors its four outcomes: the id is taken → 409; a claim redeemed with its
  // nonce → the run is the CLAIMANT's and the claim is consumed; a claim the
  // request cannot redeem → 409; no claim → the session's own member, which is
  // the browser-started path (05 access: "started_by is recorded").
  http.post('/api/workflow/runs', async ({ request }) => {
    // `toRunRow` never coerces `driveKey` onto the row (spec 11 D28) — it is the
    // driver's nonce, not something a kickoff body may set — so `row` already
    // strips it whatever the client sent.
    const row = toRunRow(await body(request))
    // The create rule's own backstop (07 `runId=`): the page checks first, but
    // a race between that read and this insert — two dispatches racing the
    // same pre-minted id — must still refuse rather than silently overwrite
    // the first run's row.
    if (db.runs.has(row.runId)) return RUN_EXISTS()

    const claim = db.claims.get(row.runId)
    const sent = (request.headers.get(DRIVE_KEY_HEADER) ?? '').trim()
    // A claim nobody can redeem is not an opening: a driver that cannot prove
    // it was dispatched must not take a claimed id either.
    if (claim && (sent === '' || sent !== claim.driveKey)) return RUN_EXISTS()

    const stored: MockRunRow = claim
      ? { ...row, startedBy: claim.startedBy, startedByEmail: claim.startedByEmail, driveKey: claim.driveKey, _id: nextId() }
      : { ...row, startedBy: mockUser().id, startedByEmail: mockUser().email, _id: nextId() }
    db.runs.set(stored.runId, stored)
    // One dispatch, one run: the claim is spent once the row exists.
    if (claim) db.claims.delete(row.runId)
    return HttpResponse.json(toRecord(stored))
  }),

  // `run/drive` (ADR-0006, spec 11 D28) — the mock stands in for the rule, not
  // for GitHub: it takes the same decisions (the gate's body checks, then the
  // claim on `run` or the rekey on `resume`) and answers the same 202 receipt,
  // but dispatches nothing. `repo` is a stand-in for whatever `driver.repo` the
  // implementation's index publishes; there is no index fetch here, so there is
  // no NO_DRIVER branch either.
  //
  // The nonce is `crypto.randomUUID()` rather than the real gate's
  // `utils.randomToken(24)` — the mock has no CE `utils` — and, exactly as in
  // the rule, it NEVER appears in the response: the driver would have received
  // it in `client_payload`, and a test reads it from `db` the same way.
  http.post('/api/workflow/run/drive', async ({ request }) => {
    const fields = await body(request)
    const id = String(fields.id ?? '')
    const mode = String(fields.mode ?? '')
    const impl = String(fields.impl ?? '')
    const workflow = String(fields.workflow ?? '')
    const bad = (message: string) => drivenRefusal('BAD_REQUEST', message)

    // The real gate's body checks, in its order. `RUN_ID_PATTERN` is the mock's
    // looser one (its own fixtures are not ULIDs) — the shape is what matters.
    if (!RUN_ID_PATTERN.test(id)) return bad('`id` must be run_ followed by 26 Crockford-base32 characters')
    if (mode !== 'run' && mode !== 'resume') return bad('`mode` must be run or resume')
    if (mode === 'run') {
      if (!IMPL_PATTERN.test(impl)) return bad('`impl` must name the implementation alias to run')
      if (workflow === '') return bad('`workflow` must name the workflow to run')
      if (!isObject(fields.inputs)) return bad('`inputs` must be a JSON object of input values')
    }

    if (mode === 'resume') {
      const run = db.runs.get(id)
      // The shared gate (D26): an unknown run and one this caller cannot reach
      // are one answer, so a run id leaks nothing.
      if (!run || !mockGate(run, request, mockUser()).ok) {
        return drivenRefusal('RUN_NOT_FOUND', 'no run with this id — start one instead')
      }
      if (TERMINAL_STATUSES.includes(run.status)) return drivenRefusal('RUN_TERMINAL', `this run is already ${run.status}`)
      if (run.leaseOwner && typeof run.leaseUntil === 'number' && run.leaseUntil > Date.now()) {
        return drivenRefusal('LEASE_LIVE', `this run is open in ${run.leaseOwner} — resume it there, or wait for the lease to expire`)
      }
      // No claim: the row already records its owner. A fresh nonce each time,
      // so a previous driver's key stops opening the run.
      db.runs.set(id, { ...run, driveKey: crypto.randomUUID() })
    } else {
      if (db.runs.has(id)) return drivenRefusal('RUN_EXISTS', 'a run with this id already exists — resume it instead')
      const existing = db.claims.get(id)
      if (existing && existing.startedBy !== mockUser().id) {
        return drivenRefusal('RUN_EXISTS', 'this run id is already claimed by another member')
      }
      // The claim is written BEFORE the (notional) dispatch, and the caller's
      // own standing claim is reused rather than re-keyed, so a retry after a
      // dispatch that never landed is safe.
      if (!existing) {
        db.claims.set(id, {
          runId: id,
          impl,
          workflow,
          startedBy: mockUser().id,
          startedByEmail: mockUser().email,
          driveKey: crypto.randomUUID(),
          createdAt: Date.now(),
        })
      }
    }

    return HttpResponse.json(
      { dispatched: true, runId: id, repo: 'mock/impl', eventType: 'workflow-drive' },
      { status: 202, headers: NO_STORE },
    )
  }),

  // The rule answers with the `data_query` result, envelope and all, after its
  // `shape.fn.js` has joined `waitingOn` onto each record (apps#473) — the keys
  // of the run's step rows in `waiting`; `runs.shape.fn.parity.test.ts` holds
  // the mock to the authored function.
  //
  // Scope (spec 11 §Listing, §D27): the caller's own runs by default;
  // `?scope=all` (or `x-workflow-scope: all`) only for a project owner/admin,
  // 403 otherwise — `scope.fn.parity.test.ts` holds this branch to the
  // authored `scope.fn.js`.
  http.get('/api/workflow/runs', ({ request }) => {
    const url = new URL(request.url)
    const impl = url.searchParams.get('impl')
    const workflow = url.searchParams.get('workflow')
    const asked = url.searchParams.get('scope') === 'all' || request.headers.get('x-workflow-scope') === 'all'
    const role = String(mockUser().projectRole || '').toLowerCase()

    if (asked && role !== 'owner' && role !== 'admin') {
      return HttpResponse.json(
        { ok: false, error: 'scope=all needs the project owner or admin role', code: 'SCOPE_FORBIDDEN' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      )
    }

    const records = [...db.runs.values()]
      .filter((row) => (impl === null || row.impl === impl) && (workflow === null || row.workflow === workflow))
      .filter((row) => asked || row.startedBy === mockUser().id)
      .map((row) => ({ ...toRecord(row), waitingOn: waitingKeysOf(row.runId) }))
    return HttpResponse.json({ records }, { headers: { 'Cache-Control': 'no-store' } })
  }),

  // Gated (spec 11 D26): Decision 4 — an id nothing was recorded for and a run
  // this caller cannot reach answer the SAME 200 `{ run: null, steps: [] }`,
  // never a 404, so a run id leaks nothing about whether it exists (mirrors
  // `run/get/shape.fn.js`).
  http.get('/api/workflow/run', ({ request }) => {
    const id = new URL(request.url).searchParams.get('id') ?? ''
    const run = db.runs.get(id)
    if (!mockGate(run, request, mockUser()).ok) {
      return HttpResponse.json({ run: null, steps: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return HttpResponse.json(
      { run: run ? toRecord(run) : null, steps: stepsOf(id).map(toRecord) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }),

  // Gated (spec 11 D26): unknown and invisible both refuse with the same 404
  // `{ ok:false, error:'run not found' }` — `steps.runGate.result` on the real
  // rule's `refuse-404` responder.
  http.post('/api/workflow/run/update', async ({ request }) => {
    const { id, patch } = await body(request)
    const run = db.runs.get(String(id))
    // `!run` first, like every other gated handler here: `mockGate` answers the
    // same refusal for an absent row, so this only narrows the type.
    if (!run || !mockGate(run, request, mockUser()).ok) {
      return refuse(404, 'run not found')
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
  // list: only the 12 mutable step columns are ever patched; `job`/`index`/
  // `step`/`kind` are identity, set once on the row's first write.
  //
  // Gated (spec 11 D26): a step row belongs to its PARENT run, so the gate
  // reads THAT row — a caller who cannot reach the run gets the same 404 as
  // `run/update`, never a stray write to a run they cannot see.
  http.post('/api/workflow/run-step', async ({ request }) => {
    const { runId, key, patch } = await body(request)
    const parentRun = db.runs.get(String(runId))
    if (!mockGate(parentRun, request, mockUser()).ok) {
      return refuse(404, 'run not found')
    }
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

  // Gated (spec 11 D26): unknown and invisible both refuse the same 404
  // `{ ok:false, error:'run not found' }` — ownership is `mockGate`'s answer,
  // not this handler's, mirroring the real rule's `runGate` step ahead of
  // `gate.fn.js`. Only then the rule's own business: 409 while running
  // (cancel is the way out), then the deletion itself, files first, because a
  // retry of a half-done delete must never leave a row pointing at bytes that
  // are already gone.
  http.post('/api/workflow/run/delete', async ({ request }) => {
    const { id } = await body(request)
    const run = db.runs.get(String(id))
    if (!run || !mockGate(run, request, mockUser()).ok) return refuse(404, 'run not found')
    if (run.status === 'running') return refuse(409, 'cancel the run first')

    // Both counts, swept independently: `files` by prefix (what `file_delete` does),
    // `records` by a real anchored `sub_dir LIKE '<prefix>%'` over `db.fileRecords`
    // (what `data_delete` does). Reporting `files` twice — which is what this did while
    // the mock had no `workflow_files` table — made a `records: 0` regression
    // unrepresentable, so CI could not catch the one step whose correctness rides on
    // CE's uploads-relative `sub_dir` shape (apps#381).
    const { files, records } = deleteRun(run.runId)
    return HttpResponse.json({ ok: true, deleted: { files, records } }, { headers: NO_STORE })
  }),

  // Gated (spec 11 D26): the caller must be able to reach the PARENT run
  // (`from`) — `mockGate` decides that before `forkGate` (see `forkGate.ts`)
  // ever runs, mirroring the real rule's `runGate` step ahead of `gate.fn.js`.
  // Then `forkGate`'s own refusal responders (400/404/409), then the rule's
  // two writes: the run row once (`create`, skipped when a previous call of
  // the same `id` already made it), and the adopted rows insert-only (`copy`,
  // a `data_upsert_many` deduped on `rowKey` = `<runId>/<key>` — which is
  // exactly the identity this table is keyed by, so "already present" is the
  // same test). A retry therefore leaves one run row and one copy of each
  // adopted row, and reports `copied: 0` (apps#501).
  http.post('/api/workflow/run/fork', async ({ request }) => {
    const fields = await body(request)
    const from = String(fields.from ?? '')
    const parent = db.runs.get(from)
    if (!mockGate(parent, request, mockUser()).ok) return refuse(404, 'run not found')

    const gate = forkGate({
      parent: parent ?? null,
      rows: stepsOf(from),
      existing: db.runs.get(String(fields.id ?? '')) ?? null,
      body: fields,
      user: mockUser(),
    })
    if (gate.status !== 200) return refuse(gate.status, gate.error)

    if (gate.createRun) db.runs.set(gate.run.runId, { ...gate.run, _id: nextId() })
    let copied = 0
    for (const row of gate.rows) {
      const id = stepRowKey(row.runId, row.key)
      if (db.steps.has(id)) continue
      const { rowKey: _rowKey, ...columns } = row
      void _rowKey
      db.steps.set(id, { ...columns, _id: nextId() })
      copied += 1
    }
    return HttpResponse.json({ ok: true, runId: gate.run.runId, copied }, { headers: NO_STORE })
  }),

  // Mirrors `gate.fn.js`: granted when unheld, expired, already ours, or forced.
  // Gated (spec 11 D26) first: an unknown run, or one this caller cannot
  // reach, refuses 404 — the same shape as delete/fork — rather than lease's
  // old 200 `{ ok:false, error:'run not found' }`.
  http.post('/api/workflow/run/lease', async ({ request }) => {
    const { id, owner, takeover } = await body(request)
    const run = db.runs.get(String(id))
    if (!run || !mockGate(run, request, mockUser()).ok) return refuse(404, 'run not found')

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
// The files quartet (06) — the harness owns where bytes live
// ---------------------------------------------------------------------------

const MOCK_UPLOAD_PREFIX = '/mock-upload/'

function storageKey(fields: Record<string, unknown>): string {
  return ['workflows', fields.impl, fields.workflow, fields.scope, fields.filename]
    .map((part) => String(part ?? '').replace(/^\/+|\/+$/g, ''))
    .filter((part) => part !== '')
    .join('/')
}

/**
 * `run_...` — the shape a runId takes wherever the harness mints one (`nextId`'s `run`
 * prefix). Mirrors the real rules' `confine.fn.js`/`normalize.fn.js` locators (spec 11 D29).
 */
const RUN_ID_PATTERN = /^run_[0-9A-Za-z]+$/

/**
 * The runId in a `workflows/<impl>/<workflow>/runs/<runId>/…` path, or `''` for anything else
 * (`inputs/…` included) — the same grammar the real rules' `confine.fn.js`/`normalize.fn.js`
 * parse off the equivalent normalised path. `''` is this mock's spelling of "runless": D18's
 * per-workflow `inputs/` area carries no runId and stays member-wide.
 *
 * The `runs` segment matches CASE-INSENSITIVELY (fix round 1): CE's file_serve_handler builds
 * the storage key from the same raw path with no case folding, so on a local-filesystem install
 * with a case-insensitive volume, `RUNS/run_X/…` and `runs/run_X/…` name the SAME stored
 * object — the gate must be at least as strict as that key equality.
 */
function runIdIn(path: string): string {
  const match = /^workflows\/[^/]+\/[^/]+\/runs\/([^/]+)/i.exec(path)
  return match && RUN_ID_PATTERN.test(match[1]) ? match[1] : ''
}

/** The same locator over `prepare`'s `scope` (no `workflows/<impl>/<workflow>/` head to strip); same case-insensitive `runs`. */
function runIdInScope(scope: string): string {
  const match = /^runs\/([^/]+)\/.+/i.exec(scope)
  return match && RUN_ID_PATTERN.test(match[1]) ? match[1] : ''
}

/** A single path segment: non-empty, no `/`, no `\`, no `..` (mirrors `files/prepare`'s `confine.fn.js` `isSegment`, fix round 1). */
function isSegment(v: unknown): v is string {
  return typeof v === 'string' && v !== '' && !v.includes('/') && !v.includes('\\') && !v.includes('..')
}

/**
 * Mirrors `confine.fn.js` (spec 11 D29): the normalisation `files/sign`'s and the serve
 * rule's `confine.fn.js` both apply, plus the run locator. `ok` is the "under workflows/,
 * no traversal" check; `runless` is `ok` minus `hasRun` — nothing under `workflows/` is
 * ever both.
 */
function confinePath(raw: string): { ok: boolean; path: string; hasRun: boolean; runId: string; runless: boolean } {
  const path = raw.replace(/^\/+/, '').replace(/^api\/uploads\//, '').split('?')[0]
  const ok = path.startsWith('workflows/') && !path.includes('..') && !path.includes('//')
  const runId = ok ? runIdIn(path) : ''
  const hasRun = runId !== ''
  return { ok, path, hasRun, runId, runless: ok && !hasRun }
}

/**
 * `steps.runGate.ok` for a parsed runId, through the SAME `mockGate` every other gated route
 * uses (fix round 1: this used to shortcut past `mockGate` for a runless path, and never passed
 * `bodyScope` at all — so an admin's `scope:'all'` in a `files/sign` body, say, had no effect
 * here though the real `runGate.fn.js` honours it). `runless` is a parsed `''` runId; `bodyScope`
 * is the request's own `scope` field where the caller's route has one — `undefined` (a GET) is
 * simply never `'all'`.
 */
function fileGateOk(runId: string, request: Request, bodyScope?: string): boolean {
  return mockGate(db.runs.get(runId), request, mockUser(), { runless: runId === '', bodyScope }).ok
}

const files = [
  // Gated (spec 11 D29): `scope` must be `inputs`/`inputs/…` (D18, member-wide) or
  // `runs/<runId>/<step>` — anything else is the rule's `confine.fn.js` 400. A
  // `runs/<runId>/…` scope then needs THIS caller to reach that run, the same 404
  // `mockGate` answers everywhere else (never a stray presigned URL into a run this
  // caller cannot see).
  //
  // `impl`/`workflow` are ALSO checked (fix round 1): `storageKey`'s subDir templates them
  // unvalidated, so a caller who controls `workflow` (e.g. `"x/runs/run_VICTIM/step"`) could
  // otherwise plant bytes under another member's run prefix without `scope` naming it at all.
  http.post('/api/workflow/files/prepare', async ({ request }) => {
    const fields = await body(request)
    const identifiersOk = isSegment(fields.impl) && isSegment(fields.workflow)
    const scope = typeof fields.scope === 'string' ? fields.scope.replace(/^\/+|\/+$/g, '') : ''
    const clean = scope !== '' && !scope.includes('..') && !scope.includes('//')
    const isInputs = clean && (scope === 'inputs' || scope.startsWith('inputs/'))
    const runId = clean ? runIdInScope(scope) : ''

    if (!identifiersOk || (!isInputs && runId === '')) {
      return HttpResponse.json({ error: 'scope must be inputs or runs/<runId>/<step>' }, { status: 400 })
    }
    if (!fileGateOk(runId, request, scope)) return refuse(404, 'run not found')

    const key = storageKey(fields)
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

  // Writes the `workflow_files` row as well as answering the File ref: `register_upload`
  // is the only thing that creates one, and the run-delete sweep is counted off it.
  //
  // Mirrors `normalize.fn.js` first: `storageKey` may be the full key `prepare`
  // minted (`<owner>/<repo>/uploads/workflows/…`), the bare uploads-relative path a
  // pipeline step returned where a `file` output is declared (spec 02), or either
  // behind a leading `/` or `/api/uploads/`. Every accepted spelling must land on
  // the SAME uploads-relative `db.files` key — the one the PUT stored under and the
  // serve route and the delete sweep look up — or a bare-path register writes a row
  // nobody can find (apps#472). Anything not under `workflows/`, or carrying `..` or
  // `//`, is the rule's `refuse` step: 400 with the `BAD_PATH` envelope.
  //
  // Gated (spec 11 D29) next: a key under a run's `runs/<runId>/` prefix needs THIS
  // caller to reach that run — the SAME 404 `{ok:false,error:'run not found'}` every
  // other gated route answers (`steps.runGate.result`), a different envelope than the
  // 400 above (that one is the rule's own `normalize.fn.js` refusal, not the gate's).
  http.post('/api/workflow/files/register', async ({ request }) => {
    const fields = await body(request)
    const raw = (typeof fields.storageKey === 'string' ? fields.storageKey : '')
      .replace(/^\/+/, '')
      .replace(/^api\/uploads\//, '')
    const key = raw.startsWith(MOCK_UPLOADS_ROOT) ? raw.slice(MOCK_UPLOADS_ROOT.length) : raw

    if (!key.startsWith('workflows/') || key.includes('..') || key.includes('//')) {
      return HttpResponse.json(
        {
          success: false,
          error: {
            code: 'BAD_PATH',
            message: 'storageKey must be an uploads-relative path under workflows/ with no traversal',
          },
        },
        { status: 400 },
      )
    }
    const bodyScope = typeof fields.scope === 'string' ? fields.scope : undefined
    if (!fileGateOk(runIdIn(key), request, bodyScope)) return refuse(404, 'run not found')

    const stored = db.files.get(key)
    const originalName = typeof fields.originalName === 'string' ? fields.originalName : undefined
    registerFileRecord(key, {
      contentType: stored?.contentType,
      size: stored?.bytes.byteLength ?? 0,
      originalName,
    })
    return HttpResponse.json(
      toFileRef({
        path: key,
        name: fields.originalName,
        contentType: stored?.contentType,
        size: stored?.bytes.byteLength ?? 0,
      }),
    )
  }),

  // `workflow.sign` (Decision 6). Stands in for `confine.fn.js` + `signed_url`:
  // the same normalisation and the same refusal, and — where the real rule
  // answers a bucket URL — a serve URL with a marker query. **Absolute**, and
  // that matters: the island that reads it lives in an opaque-origin `srcdoc`
  // frame, which has no base URL to resolve a relative one against.
  //
  // Gated (spec 11 D29) next: a `runs/<runId>/` path needs THIS caller to reach
  // that run; `inputs/` and any other confined path carry no runId and stay
  // member-wide (D18), so `fileGateOk` passes them without a lookup.
  http.post('/api/workflow/files/sign', async ({ request }) => {
    const fields = await body(request)
    const confine = confinePath(String(fields.path ?? ''))

    if (!confine.ok) {
      return HttpResponse.json(
        { error: 'path must be an uploads-relative key under workflows/ with no traversal' },
        { status: 400 },
      )
    }
    const bodyScope = typeof fields.scope === 'string' ? fields.scope : undefined
    if (!fileGateOk(confine.runId, request, bodyScope)) return refuse(404, 'run not found')

    const url = new URL(`/api/uploads/${confine.path}?signed=mock`, request.url).href
    return HttpResponse.json({ url, expiresIn: 3600 })
  }),

  // The serve rule is CE's file_serve_handler at /api/uploads/<subDir>/…, so the
  // route is the uploads-relative storage path itself (see `fileUrl`).
  //
  // Gated (spec 11 D29): mirrors the serve rule's own `confine.fn.js` + `runGate` —
  // there is no 400 here (see that rule's comment), so a path that fails to parse
  // AND a `runs/<runId>/` path this caller cannot reach answer the SAME 404 JSON
  // body `{"error":"not found"}` the rule's `refuse-404` responder does; only past
  // the gate does a missing object fall through to the plain (bodyless) 404 that
  // stood in for CE's own file_serve_handler not-found before this task.
  http.get('/api/uploads/*', ({ request, params }) => {
    const confine = confinePath(decodeURIComponent(String(params['0'] ?? '')))
    if (!confine.ok || !fileGateOk(confine.runId, request)) {
      return HttpResponse.json({ error: 'not found' }, { status: 404 })
    }

    const stored = db.files.get(confine.path)
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
// Identity — `user.*` read back, for the header and the delete gate's UI half
// ---------------------------------------------------------------------------

const identity = [
  // Exactly the three fields `me.fn.js` picks (`whoami.fn.parity.test.ts`) —
  // `projectRole` is a gate-only signal (spec 11), never part of this contract.
  http.get('/api/workflow/whoami', () => {
    const { id, email, role } = mockUser()
    return HttpResponse.json({ id, email, role }, { headers: NO_STORE })
  }),
]

// ---------------------------------------------------------------------------
// Auth — the SuperTokens refresh relay the data layer retries through (R5)
// ---------------------------------------------------------------------------

const auth = [http.post('/api/auth/session/refresh', () => new HttpResponse(null, { status: 200 }))]

export const handlers = [...discovery, ...runRecord, ...files, ...hello, ...identity, ...auth]
