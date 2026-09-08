/**
 * Pure job-level readings of a run (spec 2026-09-08): what the rail, the job
 * head and the graph node all print, in one place so they cannot disagree.
 */
import { stepConclusion } from './contexts'
import { jobResult } from './graph'
import type { JobResult } from './graph'
import type { Definition, RunState, Step, StepKey, StepState, StepStatus } from './types'
import { stepKey } from './types'

/** `jobResult`'s six-way answer, restated in the eight-way vocabulary the UI's glyphs speak. */
const JOB_RESULT_STATUS: Record<JobResult, StepStatus> = {
  pending: 'queued',
  running: 'running',
  success: 'succeeded',
  failure: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
}

/**
 * A job's (or one matrix item's) status, as the *engine* reads it (Task 17b)
 * — not the worst of its steps. A step that failed under `continue-on-error`
 * is absorbed: it does not fail the job, even though the step's own row still
 * shows `failed` (the step glyph tells the truth about the step; this tells
 * the truth about the job).
 *
 * Without `index` this is the whole job, and `jobResult` (`graph.ts`) already
 * computes exactly that — the same reading the scheduler's `needs` gating
 * uses, so the rail/graph/head can never disagree with it. `jobResult`
 * delegates a complete job to `jobOutcome` (`contexts.ts`), which folds every
 * matrix item's steps together under the same
 * failure/cancelled/skipped/success rules this function would otherwise
 * apply one item at a time — so mapping it is not a narrower answer than "the
 * worst item", it is the same answer computed once instead of per item. The
 * one gap it leaves is `waiting`: `jobResult` has no notion of a step parked
 * on a form, so a `running` result is downgraded to `waiting` here whenever
 * one of the job's steps actually is.
 *
 * With `index`, `jobResult`/`jobOutcome` have no per-item view — they fold
 * every item's steps together — so this evaluates the same rule directly over
 * that one item's steps.
 */
export function jobStatus(def: Definition, state: RunState, job: string, index?: number): StepStatus {
  const steps = stepsOfJob(def, state, job, index).flatMap((r) => (r.state ? [r.state] : []))
  if (index === undefined) {
    const result = jobResult(def, state, job)
    if (result === 'running' && steps.some((s) => s.status === 'waiting')) return 'waiting'
    return JOB_RESULT_STATUS[result]
  }
  return itemStatus(def, steps)
}

/**
 * The per-item rule `jobStatus` applies to one matrix item: `cancelled` beats
 * `failed` beats `waiting`/`running`, a step that failed under
 * `continue-on-error` (`stepConclusion`) does not count as a failure, and
 * `succeeded` only once every reached step is terminal (`skipped` only when
 * every one of them is).
 */
function itemStatus(def: Definition, steps: StepState[]): StepStatus {
  if (steps.length === 0) return 'queued'
  if (steps.some((s) => s.status === 'cancelled')) return 'cancelled'
  if (steps.some((s) => stepConclusion(def, s) === 'failure')) return 'failed'
  if (steps.some((s) => s.status === 'waiting')) return 'waiting'
  if (steps.some((s) => s.status === 'running' || s.status === 'polling')) return 'running'
  if (steps.every((s) => isTerminal(s.status))) {
    return steps.every((s) => s.status === 'skipped') ? 'skipped' : 'succeeded'
  }
  return 'queued'
}

/**
 * A step that will not move again (05): its row is the whole story, so a
 * caller can count it as done, print its duration rather than its status word,
 * and stop watching it. `queued`/`running`/`polling`/`waiting` are the four
 * that can still change.
 */
const TERMINAL: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
])

export function isTerminal(status: StepStatus): boolean {
  return TERMINAL.has(status)
}

export function jobDuration(steps: StepState[]): number | undefined {
  const started = steps.filter((s) => s.startedAt !== undefined)
  if (started.length === 0 || started.some((s) => s.finishedAt === undefined)) return undefined
  const start = Math.min(...started.map((s) => s.startedAt!))
  const end = Math.max(...started.map((s) => s.finishedAt!))
  return end - start
}

export function itemTotal(state: RunState, job: string): number {
  return state.expansions[job]?.total ?? 1
}

export interface JobStepRow { key: StepKey; step: Step; index: number; state: StepState | undefined }

/**
 * The same rows, for a job nothing has run: the workflow page's declared list
 * (spec §The workflow page). There is no fan-out before a run — a matrix job's
 * items are a fact only a run has — so every row is the job's one and only
 * leg, `/0`, carrying the step key a run of it would use.
 */
export function declaredStepsOfJob(def: Definition, job: string): JobStepRow[] {
  return (def.jobs[job]?.steps ?? []).map((step) => ({
    key: stepKey(job, 0, step.id),
    step,
    index: 0,
    state: undefined,
  }))
}

export function stepsOfJob(def: Definition, state: RunState, job: string, index?: number): JobStepRow[] {
  const decl = def.jobs[job]
  if (!decl) return []
  const items = index === undefined ? Array.from({ length: itemTotal(state, job) }, (_, i) => i) : [index]
  return items.flatMap((i) =>
    decl.steps.map((step) => {
      const key = stepKey(job, i, step.id)
      return { key, step, index: i, state: state.steps[key] }
    }),
  )
}
