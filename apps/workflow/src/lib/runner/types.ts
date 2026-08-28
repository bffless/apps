import type { StepKind } from '@bffless/workflow-lint/definition'
export type { Definition, Job, Step, StepKind } from '@bffless/workflow-lint/definition'

export type StepStatus =
  | 'queued' | 'running' | 'polling' | 'waiting'
  | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export type StepKey = string // `<job>/<index>/<step>`

export interface FileRef { path: string; name: string; contentType: string; size: number; url: string }
export interface StepError { code: string; message: string; status?: number }
export interface Annotation { level: 'notice' | 'warning' | 'error'; title?: string; message: string; stepKey?: StepKey }

export interface StepState {
  key: StepKey; job: string; index: number; stepId: string; kind: StepKind
  status: StepStatus; attempt: number
  inputs?: Record<string, unknown>
  response?: { initial?: unknown; last?: unknown; truncated?: boolean }
  outputs?: Record<string, unknown>
  error?: StepError
  summary?: string
  annotations: Annotation[]
  startedAt?: number; finishedAt?: number
}

export interface RunState {
  runId: string; impl: string; workflow: string
  status: RunStatus; headless: boolean
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
  | { type: 'run.started'; runId: string; impl: string; workflow: string; inputs: Record<string, unknown>; headless: boolean; at: number }
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
  | { type: 'step.succeeded'; key: StepKey; outputs: Record<string, unknown>; response?: { initial?: unknown; last?: unknown; truncated?: boolean }; summary?: string; annotations?: Annotation[]; at: number }
  | { type: 'step.failed'; key: StepKey; error: StepError; annotations?: Annotation[]; at: number }
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
  | { type: 'step.cancelled'; key: StepKey; at: number }
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
