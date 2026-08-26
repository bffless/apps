/**
 * The mock backend's storage: the two Data Tables of 05, the bytes a "bucket"
 * would hold, and the hello service's job rows. In-memory and per-process, so
 * `resetDb()` in a test's `afterEach` is the whole isolation story.
 */
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'
import { FINISHED_RUN } from './fixtures/finishedRun'
import { RENDERED_RUN } from './fixtures/renderedRun'
import { SCRIPT_RUN } from './fixtures/scriptRun'

export interface MockFile {
  bytes: Uint8Array
  contentType: string
}

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
  helloJobs: Map<string, MockJob>
  /** Request bodies already answered with one BUSY, so the retry is the one that lands (R7). */
  helloBusy: Set<string>
  seq: number
}

export const db: MockDb = {
  runs: new Map(),
  steps: new Map(),
  files: new Map(),
  helloJobs: new Map(),
  helloBusy: new Set(),
  seq: 0,
}

export function resetDb(): void {
  db.runs.clear()
  db.steps.clear()
  db.files.clear()
  db.helloJobs.clear()
  db.helloBusy.clear()
  db.seq = 0
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
