/**
 * The persistence rows of 05 and the **write path**: one `PersistWrite` per
 * persisted `RunEvent`.
 *
 * The record of a run is server-side (05); the engine (09) produces events and
 * every event becomes exactly one row write before the engine proceeds. This
 * module is the single place that knows which column each event touches, so the
 * live write path and Resume's `replay.ts` can never disagree about what a row
 * means.
 *
 * Column names are camelCase here — the harness rule set (Task 1) maps them onto
 * the Data Table columns, and nothing above this module should have to know the
 * wire spelling.
 *
 * Two shapes deliberately have no write: `job.expanded` is *derived* (a job is
 * the fold of its step rows + the definition, 05) and `run.heartbeat` is not an
 * engine event at all — the lease is owned by the driving tab, not the reducer.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import { trimResponse } from './results'
import type {
  Annotation,
  RunEvent,
  RunState,
  RunStatus,
  StepError,
  StepKey,
  StepKind,
  StepState,
  StepStatus,
} from './types'

/** `workflow_runs` (05). */
export interface RunRow {
  runId: string
  impl: string
  workflow: string
  workflowName: string
  workflowVersion?: string
  /** The **parsed** definition snapshotted at start (D16) — never re-read from the alias. */
  definition: unknown
  yaml: string
  inputs: Record<string, unknown>
  status: RunStatus
  headless: boolean
  startedBy?: string
  startedAt: number
  finishedAt?: number | null
  leaseOwner?: string | null
  leaseUntil?: number | null
  outputs?: Record<string, unknown> | null
  annotations?: Annotation[] | null
}

/** `workflow_run_steps` — one row per (job, matrix index, step); the key is `<job>/<index>/<step>`. */
export interface StepRow {
  runId: string
  key: StepKey
  job: string
  index: number
  step: string
  kind: StepKind
  status: StepStatus
  attempt: number
  inputs?: unknown
  response?: unknown
  outputs?: unknown
  error?: StepError | null
  summary?: string | null
  annotations?: Annotation[] | null
  startedAt?: number | null
  finishedAt?: number | null
  heartbeatAt?: number | null
}

export type PersistWrite =
  | { table: 'runs'; op: 'create'; row: RunRow }
  | { table: 'runs'; op: 'patch'; id: string; patch: Partial<RunRow> }
  | { table: 'steps'; op: 'upsert'; runId: string; key: StepKey; patch: Partial<StepRow> }

export interface WriteContext {
  /** The **post-event** state — the row must mirror what the reducer just produced. */
  state: RunState
  /** Builds the insert row for `run.started`; the caller owns yaml/definition/lease. */
  runRow?: () => RunRow
}

function upsert(runId: string, key: StepKey, patch: Partial<StepRow>): PersistWrite {
  return { table: 'steps', op: 'upsert', runId, key, patch }
}

function patchRun(id: string, patch: Partial<RunRow>): PersistWrite {
  return { table: 'runs', op: 'patch', id, patch }
}

/**
 * The step as it looks *after* the event. Reading the post-event state (rather
 * than the event payload) is what keeps a row a faithful mirror of the step —
 * `attempt` after a retry, the merged `response` after `step.polling`, and the
 * annotations a terminal event may or may not have carried.
 */
function after(state: RunState, key: StepKey): StepState {
  const step = state.steps[key]
  if (!step) throw new Error(`eventToWrites: unknown step ${key}`)
  return step
}

/** Identity columns, denormalised onto the row so a step list needs no join (05). */
function identity(s: StepState): Partial<StepRow> {
  return { job: s.job, index: s.index, step: s.stepId, kind: s.kind }
}

/** The 05 write-path table: one write per persisted event; `[]` for derived events. */
export function eventToWrites(event: RunEvent, ctx: WriteContext): PersistWrite[] {
  const { state } = ctx
  const runId = state.runId

  switch (event.type) {
    case 'run.started': {
      if (!ctx.runRow) {
        throw new Error('eventToWrites: run.started needs ctx.runRow() to build the insert row')
      }
      return [{ table: 'runs', op: 'create', row: ctx.runRow() }]
    }

    // Job state is derived from the step rows + the definition (05): nothing to write.
    case 'job.expanded':
      return []

    case 'step.queued': {
      const s = after(state, event.key)
      return [upsert(runId, event.key, { ...identity(s), status: 'queued', attempt: s.attempt })]
    }

    case 'step.skipped': {
      const s = after(state, event.key)
      return [
        upsert(runId, event.key, {
          ...identity(s),
          status: 'skipped',
          attempt: s.attempt,
          finishedAt: event.at,
        }),
      ]
    }

    case 'step.started': {
      const s = after(state, event.key)
      return [
        upsert(runId, event.key, { status: 'running', inputs: s.inputs, startedAt: s.startedAt }),
      ]
    }

    // The 256 KB response budget (05) is a *persistence* cap, and polling is
    // where it bites: a step that dies mid-poll never reaches the terminal
    // write that would otherwise trim it, and its untrimmed row is exactly the
    // row Resume reads back. Live state keeps the full `initial`; only the row
    // is capped.
    case 'step.polling': {
      const s = after(state, event.key)
      return [upsert(runId, event.key, { status: 'polling', response: trimResponse(s.response ?? {}) })]
    }

    case 'step.waiting':
      return [upsert(runId, event.key, { status: 'waiting' })]

    case 'step.retrying': {
      const s = after(state, event.key)
      return [upsert(runId, event.key, { status: 'queued', attempt: s.attempt, error: s.error })]
    }

    case 'step.succeeded': {
      const s = after(state, event.key)
      return [
        upsert(runId, event.key, {
          status: 'succeeded',
          outputs: s.outputs,
          response: s.response,
          summary: s.summary ?? null,
          annotations: s.annotations,
          finishedAt: s.finishedAt,
        }),
      ]
    }

    case 'step.failed': {
      const s = after(state, event.key)
      return [
        upsert(runId, event.key, {
          status: 'failed',
          error: s.error,
          annotations: s.annotations,
          finishedAt: s.finishedAt,
        }),
      ]
    }

    case 'step.cancelled': {
      const s = after(state, event.key)
      return [upsert(runId, event.key, { status: 'cancelled', finishedAt: s.finishedAt })]
    }

    // Dynamic progress from a step that has not finished (Decision 12): the
    // reducer already merged the append/replace, so the row is simply the
    // post-event columns — "appended to the same columns" (05), no new table.
    case 'step.annotated': {
      const s = after(state, event.key)
      return [upsert(runId, event.key, { annotations: s.annotations, summary: s.summary ?? null })]
    }

    // Run-level annotations are an append-only column; the post-event state
    // already holds the whole array, so the patch is the array (05).
    case 'run.annotation':
      return [patchRun(runId, { annotations: state.annotations })]

    // The lease belongs to the tab that was driving: a finished run has no driver.
    case 'run.finished':
      return [
        patchRun(runId, {
          status: event.status,
          outputs: event.outputs,
          finishedAt: event.at,
          leaseOwner: null,
          leaseUntil: null,
        }),
      ]

    default: {
      const exhaustive: never = event
      throw new Error(`eventToWrites: unknown run event: ${JSON.stringify(exhaustive)}`)
    }
  }
}
