/**
 * The mock backend's storage: the two Data Tables of 05, the bytes a "bucket"
 * would hold, and the hello service's job rows. In-memory and per-process, so
 * `resetDb()` in a test's `afterEach` is the whole isolation story.
 */
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'
import { FINISHED_RUN } from './fixtures/finishedRun'
import { RENDERED_RUN } from './fixtures/renderedRun'
import { SCRIPT_RUN } from './fixtures/scriptRun'
import { WAITING_RUN } from './fixtures/waitingRun'

export interface MockFile {
  bytes: Uint8Array
  contentType: string
}

/**
 * A `workflow_files` row, in CE's own column names.
 *
 * `register_upload` writes exactly these seven keys whatever the target schema
 * declares (`UploadRecordService.createUploadRecords`, ce
 * `upload-schema-contract.ts` `UPLOAD_RECORD_FIELDS`) — which is why the mock
 * spells them snake_case while every other table here uses the camelCase names
 * this rule set's own schemas declare.
 */
export interface MockFileRecord {
  filename: string
  storage_path: string
  content_type: string
  size: number
  url: string
  sub_dir: string
  original_name: string
}

/**
 * The `<owner>/<repo>/uploads/` head CE namespaces every storage key with.
 *
 * A record's `storage_path` is the FULL object key, not the uploads-relative
 * one the harness passes around — which is the entire reason the delete rule's
 * filter is `storage_path LIKE '%<prefix>%'` with a LEADING wildcard. Modelling
 * that head here is what makes the mock able to fail on an anchored pattern the
 * way the real table would.
 */
export const MOCK_UPLOADS_ROOT = 'bffless/workflow/uploads/'

/** A `hello` slow-job row; `polls` is what makes the second poll the finished one (R7). */
export interface MockJob {
  polls: number
  result: { markdown: string; posterPath: string | null; ms: number }
}

export interface MockDb {
  /** `workflow_runs`, keyed by `runId`. */
  runs: Map<string, ServerRunRow>
  /** `workflow_run_steps`, keyed `<runId>|<stepKey>`. */
  steps: Map<string, ServerStepRow>
  /** Uploaded objects, keyed by storage key. */
  files: Map<string, MockFile>
  /** `workflow_files` — the upload records, keyed by the same storage key. */
  fileRecords: Map<string, MockFileRecord>
  helloJobs: Map<string, MockJob>
  /** Request bodies already answered with one BUSY, so the retry is the one that lands (R7). */
  helloBusy: Set<string>
  seq: number
}

export const db: MockDb = {
  runs: new Map(),
  steps: new Map(),
  files: new Map(),
  fileRecords: new Map(),
  helloJobs: new Map(),
  helloBusy: new Set(),
  seq: 0,
}

export function resetDb(): void {
  db.runs.clear()
  db.steps.clear()
  db.files.clear()
  db.fileRecords.clear()
  db.helloJobs.clear()
  db.helloBusy.clear()
  db.seq = 0
  currentUser = MOCK_MEMBER
}

// ---------------------------------------------------------------------------
// Identity — what CE's `user.*` expression root resolves to (id, email, role)
// ---------------------------------------------------------------------------

/** The three fields CE exposes to a pipeline as `user.*`; `null` there means unauthenticated. */
export interface MockUser {
  id: string
  email: string
  role: string
}

/** The default session: the ordinary project member every other mock test runs as. */
export const MOCK_MEMBER: MockUser = { id: 'user_mock', email: 'workflow-ci@example.test', role: 'user' }

/** The second identity, for the branches only an admin reaches (deleting someone else's run). */
export const MOCK_ADMIN: MockUser = { id: 'user_admin', email: 'admin@example.test', role: 'admin' }

let currentUser: MockUser = MOCK_MEMBER

/** Who the mock backend believes is calling — the stand-in for CE's `user.*`. */
export function mockUser(): MockUser {
  return currentUser
}

/**
 * Switch the mock's identity. Mock-only: a real session is chosen by logging
 * in, and no rule ever takes the caller's word for who they are. `resetDb()`
 * puts it back, so a test that switches cannot leak into the next one; in the
 * browser worker it is driven by `?as=admin` (see `mocks/browser.ts`).
 */
export function setMockUser(user: MockUser): void {
  currentUser = user
}

/** The record id CE would mint for a new row. */
export function nextId(prefix = 'rec'): string {
  db.seq += 1
  return `${prefix}_${db.seq}`
}

export function stepRowKey(runId: string, key: string): string {
  return `${runId}|${key}`
}

/** A stored row as a Data Table record: the columns, plus `id`. */
export function toRecord<T extends { _id?: string }>(row: T): Record<string, unknown> {
  const { _id, ...fields } = row
  return { id: _id, ...fields }
}

export function stepsOf(runId: string): ServerStepRow[] {
  return [...db.steps.values()].filter((row) => row.runId === runId)
}

/**
 * The keys of a run's steps in `waiting`, sorted — what the list rule's
 * `shape.fn.js` joins onto each run record as `waitingOn` (apps#473).
 */
export function waitingKeysOf(runId: string): string[] {
  return stepsOf(runId)
    .filter((row) => row.status === 'waiting')
    .map((row) => row.key)
    .sort()
}

/** The storage keys under one prefix — what `file_delete`'s `prefix` config sweeps. */
export function filesUnder(prefix: string): string[] {
  return [...db.files.keys()].filter((key) => key.startsWith(prefix))
}

/**
 * Write the `workflow_files` row `register_upload` would write for one object,
 * deriving the same seven fields CE derives from the storage key: `sub_dir` is
 * the key's directory, `filename` its last segment, `url` the serve route, and
 * `storage_path` the full project-namespaced key.
 */
export function registerFileRecord(
  key: string,
  meta: { contentType?: string; size?: number; originalName?: string } = {},
): MockFileRecord {
  const cut = key.lastIndexOf('/')
  const filename = cut === -1 ? key : key.slice(cut + 1)
  const record: MockFileRecord = {
    filename,
    storage_path: `${MOCK_UPLOADS_ROOT}${key}`,
    content_type: meta.contentType ?? 'application/octet-stream',
    size: meta.size ?? 0,
    url: `/api/uploads/${key}`,
    sub_dir: cut === -1 ? '' : key.slice(0, cut),
    original_name: meta.originalName ?? filename,
  }
  db.fileRecords.set(key, record)
  return record
}

/**
 * Seed one object AND its upload record — the fixture shorthand for the whole
 * prepare → PUT → register trio, for tests and mock dev that want the bytes
 * without driving three requests. The real path still writes the two halves
 * where it writes them (the PUT stores bytes, `files/register` writes the row).
 */
export function seedObject(
  key: string,
  file: MockFile,
  meta: { originalName?: string } = {},
): void {
  db.files.set(key, file)
  registerFileRecord(key, {
    contentType: file.contentType,
    size: file.bytes.byteLength,
    originalName: meta.originalName,
  })
}

/**
 * `data_delete`'s `op: like` over `storage_path`, evaluated the way SQL would:
 * `%` matches any run of characters, `_` exactly one, everything else is
 * literal. The rule builds its pattern in `gate.fn.js` (`'%' + prefix + '%'`),
 * so a mock that matched on `startsWith` instead would happily agree with a
 * filter that could never span CE's `<owner>/<repo>/uploads/` head.
 */
export function fileRecordsMatching(pattern: string): string[] {
  const rx = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`,
    's',
  )
  return [...db.fileRecords.entries()].filter(([, row]) => rx.test(row.storage_path)).map(([key]) => key)
}

/**
 * A run's storage prefix (06/D18): `workflows/<impl>/<workflow>/runs/<runId>/`.
 * Kickoff uploads live one level up under `inputs/`, so they are outside it —
 * that is the whole point of the layout, and deletion must never reach them.
 */
export function runPrefix(run: ServerRunRow): string {
  return `workflows/${run.impl}/${run.workflow}/runs/${run.runId}/`
}

/**
 * Drop one run: every object under its prefix, the `workflow_files` rows the
 * `storage_path LIKE` sweep selects, its step rows, then the run row — the same
 * order the rule's steps run in (files first, so a failure leaves a row pointing
 * at bytes rather than bytes nobody can find). Returns BOTH counts the response
 * reports, and they are counted independently on purpose: `records` is the one
 * whose correctness rides on a CE implementation detail (the full-key shape of
 * `storage_path`), so a filter that silently stops matching has to be able to
 * show up here as `records: 0` beside a non-zero `files` (apps#381). Unknown ids
 * delete nothing; the gate, not this, decides whether a caller may ask.
 */
export function deleteRun(runId: string): { files: number; records: number } {
  const run = db.runs.get(runId)
  if (!run) return { files: 0, records: 0 }
  const prefix = runPrefix(run)
  const keys = filesUnder(prefix)
  for (const key of keys) db.files.delete(key)
  const rows = fileRecordsMatching(`%${prefix}%`)
  for (const key of rows) db.fileRecords.delete(key)
  for (const step of stepsOf(runId)) db.steps.delete(stepRowKey(runId, step.key))
  db.runs.delete(runId)
  return { files: keys.length, records: rows.length }
}

/** Load one recorded run's rows — the shared half of the two seeds below. */
function seedRun(record: { run: ServerRunRow; steps: ServerStepRow[] }): void {
  db.runs.set(record.run.runId, { ...record.run, _id: nextId() })
  for (const step of record.steps) {
    db.steps.set(stepRowKey(step.runId, step.key), { ...step, _id: nextId() })
  }
}

/** Load the completed hello run (see `fixtures/finishedRun.ts`). */
export function seedFinishedRun(): void {
  seedRun(FINISHED_RUN)
}

/** Load the still-running hello run parked on its form (see `fixtures/waitingRun.ts`). */
export function seedWaitingRun(): void {
  seedRun(WAITING_RUN)
}

/**
 * Load the completed `interactive` run whose script step's `big` output is a
 * persisted `{"$file"}` pointer (see `fixtures/scriptRun.ts`). The bytes it
 * points at are seeded separately, by whoever owns `db.files` for the session
 * (`mocks/browser.ts` in mock dev) — a row can be read without them, and the
 * page then shows the "payload unavailable" chip, which is a state worth being
 * able to seed on purpose.
 */
export function seedScriptRun(): void {
  seedRun(SCRIPT_RUN)
}

/**
 * Load the completed `rendered` run whose one step declares all five named
 * renderers (see `fixtures/renderedRun.ts`, Task 17). Its two `images` File
 * refs need bytes the same way the script run's poster does — seeded
 * separately by whoever owns `db.files` for the session.
 */
export function seedRenderedRun(): void {
  seedRun(RENDERED_RUN)
}
