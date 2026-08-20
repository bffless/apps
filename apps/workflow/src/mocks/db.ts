/**
 * The mock backend's storage: the two Data Tables of 05, the bytes a "bucket"
 * would hold, and the hello service's job rows. In-memory and per-process, so
 * `resetDb()` in a test's `afterEach` is the whole isolation story.
 */
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'
import { FINISHED_RUN } from './fixtures/finishedRun'

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

/** Load the completed hello run (see `fixtures/finishedRun.ts`). */
export function seedFinishedRun(): void {
  db.runs.set(FINISHED_RUN.run.runId, { ...FINISHED_RUN.run, _id: nextId() })
  for (const step of FINISHED_RUN.steps) {
    db.steps.set(stepRowKey(step.runId, step.key), { ...step, _id: nextId() })
  }
}
