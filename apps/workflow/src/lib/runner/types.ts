import type { StepKind } from '@bffless/workflow-lint/definition'
export type { Definition, Job, Step, StepKind } from '@bffless/workflow-lint/definition'

export type StepStatus =
  | 'queued' | 'running' | 'polling' | 'waiting'
  | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export type StepKey = string // `<job>/<index>/<step>`

export interface FileRef { path: string; name: string; contentType: string; size: number; url: string }
export interface StepError { code: string; message: string; status?: number }
/**
 * `kind` marks a machine-attached annotation the run holds **at most one** of
 * (apps#526): a `run.annotation` carrying a `kind` replaces the run's previous
 * annotation of that kind instead of stacking (reducer.ts). `data` is the
 * machine half — an opaque payload the UI never renders inline
 * (`AnnotationList` shows `level`/`title`/`message` and ignores the rest);
 * today's only kind is the run page's client diagnostics attachment.
 */
export interface Annotation {
  level: 'notice' | 'warning' | 'error'
  title?: string
  message: string
  stepKey?: StepKey
  kind?: 'diagnostics'
  data?: unknown
}

export interface StepState {
  key: StepKey; job: string; index: number; stepId: string; kind: StepKind
  status: StepStatus; attempt: number
  inputs?: Record<string, unknown>
  response?: { initial?: unknown; last?: unknown; truncated?: boolean }
  outputs?: Record<string, unknown>
  error?: StepError
  summary?: string
  annotations: Annotation[]
  /**
   * A script step's recorded `ctx.log` tail (apps#527) — last 50 lines,
   * ≤ 64 KB JSON, attached to the terminal event by whoever holds the live
   * lines (`scriptLaunch` / `cancelRun`) and put back by replay. Absent on
   * every other kind, on rows from before the column existed, and on a step
   * that never logged.
   */
  log?: string[]
  startedAt?: number; finishedAt?: number
}

export interface RunState {
  runId: string; impl: string; workflow: string
  status: RunStatus; headless: boolean
  /**
   * "Don't wait for me" (07): a person's choice on an *interactive* run to
   * honour every step's `headless:` declaration exactly as a headless run does
   * — `auto` islands self-submit, `skip` forms skip with their declared outputs
   * — while steps that declared neither still wait for the person. `headless`
   * stays what the driver sets; the two are never conflated on the row.
   */
  unattended: boolean
  /** Session user that pressed Start; surfaced as `run.started_by` (01). */
  startedBy?: string
  inputs: Record<string, unknown>
  steps: Record<StepKey, StepState>
  /** matrix expansion per job: total items + the per-index variable bindings (derived, Decision 12) */
  expansions: Record<string, { total: number; items: Record<string, unknown>[] }>
  outputs?: Record<string, unknown>
  annotations: Annotation[]
  startedAt: number; finishedAt?: number
}

export type RunEvent =
  | {
      type: 'run.started'
      runId: string
      impl: string
      workflow: string
      inputs: Record<string, unknown>
      headless: boolean
      /** Optional on the event so rows written before the column existed replay unchanged. */
      unattended?: boolean
      at: number
    }
  | { type: 'job.expanded'; job: string; total: number; items: Record<string, unknown>[] } // derived — never persisted
  | { type: 'step.queued'; key: StepKey; job: string; index: number; stepId: string; kind: StepKind; at: number }
  | { type: 'step.started'; key: StepKey; inputs: Record<string, unknown>; at: number }
  | { type: 'step.polling'; key: StepKey; initial: unknown; at: number }
  | {
      type: 'step.waiting'
      key: StepKey
      /** The evaluated `with` of a step that waits without ever running (a form): its title, fields with defaults resolved, submit. */
      inputs?: Record<string, unknown>
      at: number
    }
  | { type: 'step.succeeded'; key: StepKey; outputs: Record<string, unknown>; response?: { initial?: unknown; last?: unknown; truncated?: boolean }; summary?: string; annotations?: Annotation[]; log?: string[]; at: number }
  | { type: 'step.failed'; key: StepKey; error: StepError; annotations?: Annotation[]; log?: string[]; at: number }
  | {
      type: 'step.skipped'
      key: StepKey
      job: string
      index: number
      stepId: string
      kind: StepKind
      /**
       * What a `headless: skip` (07, Decision 11) stands in for the work the
       * step never did — validated against the step's own declared map before
       * this event is emitted, so downstream expressions read it exactly as
       * they would read a real submit. A scheduler skip (`if:` false, a failed
       * need) carries none, and its outputs read `null` as they always have.
       */
      outputs?: Record<string, unknown>
      at: number
    }
  | { type: 'step.retrying'; key: StepKey; error: StepError; at: number }
  /** `log` (apps#527): a cancelled script keeps the tail it had logged, like the other terminal events. */
  | { type: 'step.cancelled'; key: StepKey; log?: string[]; at: number }
  /**
   * Dynamic annotations/summary from a still-running step (Decision 12):
   * `workflow.annotate` (islands) and `ctx.annotate` (scripts). Not a status
   * transition — it appends annotations and replaces the summary in place, and
   * is legal only while the step is `running | polling | waiting`.
   */
  | { type: 'step.annotated'; key: StepKey; annotations?: Annotation[]; summary?: string; at: number }
  | { type: 'run.annotation'; annotation: Annotation; at: number }
  | { type: 'run.finished'; status: Exclude<RunStatus, 'running'>; outputs?: Record<string, unknown>; at: number }

export const stepKey = (job: string, index: number, stepId: string): StepKey => `${job}/${index}/${stepId}`
