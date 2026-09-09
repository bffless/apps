/**
 * Pure job-level readings of a run (spec 2026-09-08): what the rail, the job
 * head and the graph node all print, in one place so they cannot disagree.
 */
import { skippedWithOutputs, stepConclusion } from './contexts'
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
 * uses. `jobResult` delegates a complete job to `jobOutcome` (`contexts.ts`),
 * which folds every matrix item's steps together under the same
 * failure/cancelled/skipped/success rules `itemStatus` below applies one item
 * at a time — so mapping it is not a narrower answer than "the worst item", it
 * is the same answer computed once instead of per item.
 *
 * With `index`, `jobResult`/`jobOutcome` have no per-item view, so `itemStatus`
 * evaluates the same rules directly over that one item's steps. The rail, the
 * graph node and the job head therefore agree because they ask *this* function
 * — with the same arguments. (They only agree if they pass the same ones: a
 * plain job's `/0` route must ask for the job, not for "item 0", which is why
 * `JobHead` passes `index` only when the job actually fanned out.)
 *
 * Two things the scheduler's answer does not know:
 *
 * - **`waiting`.** `jobResult` has no notion of a step parked on a form, so a
 *   `running` result is downgraded to `waiting` here whenever one of the job's
 *   steps actually is.
 * - **A run that ended before the job did.** `jobResult` reads `running` for
 *   any job missing a row for a declared step, and cancelling a run never
 *   writes those rows (`cancelRun` marks only the steps that already have one,
 *   and the scheduler stops proposing more once the run is not `running`) — so
 *   a cancelled run would show its interrupted jobs as Running, on reload too,
 *   for ever. When the run itself is over, `interruptedStatus` reads what
 *   actually happened instead.
 */
export function jobStatus(def: Definition, state: RunState, job: string, index?: number): StepStatus {
  const rows = stepsOfJob(def, state, job, index)
  const steps = rows.flatMap((r) => (r.state ? [r.state] : []))
  if (index === undefined) {
    const result = jobResult(def, state, job)
    if (result === 'running' || result === 'pending') {
      if (runOver(state)) return interruptedStatus(def, state, steps)
      if (result === 'running' && steps.some((s) => s.status === 'waiting')) return 'waiting'
    }
    return JOB_RESULT_STATUS[result]
  }
  // The item's own completeness, read the way `jobComplete` reads a job's: every
  // declared step of it has a terminal row.
  const complete = rows.every((r) => r.state !== undefined && isTerminal(r.state.status))
  if (!complete && runOver(state)) return interruptedStatus(def, state, steps)
  return itemStatus(def, steps)
}

/** The run itself is over: nothing left in it will move again, whatever rows are missing. */
function runOver(state: RunState): boolean {
  return state.status !== 'running'
}

/**
 * A job (or item) the run ended underneath, read off the rows that exist.
 *
 * Nothing reached it at all → `skipped`: it was never started, so it is the
 * same "produced nothing" a scheduler skip means, and calling it `cancelled`
 * would claim work was stopped that never began.
 *
 * Otherwise a cancelled run says `cancelled` — its remaining steps were not
 * skipped by a condition, they were stopped — except that an un-absorbed
 * failure still outranks it, exactly as `jobOutcome` orders the two (01: a
 * failure the cancellation interrupted is still a failure, and anything
 * downstream reading `failure()` must see it). A run that failed or succeeded
 * with a job left incomplete is read by the ordinary per-item rules over what
 * ran.
 */
function interruptedStatus(def: Definition, state: RunState, steps: StepState[]): StepStatus {
  if (steps.length === 0) return 'skipped'
  if (state.status === 'cancelled') {
    return steps.some((s) => stepConclusion(def, s) === 'failure') ? 'failed' : 'cancelled'
  }
  return itemStatus(def, steps)
}

/**
 * The per-item rule `jobStatus` applies to one matrix item — `jobOutcome`'s
 * rules (`contexts.ts`), item by item, so the two can never disagree:
 *
 * - an un-absorbed `failed` beats `cancelled` (01: with the default
 *   `fail-fast` a failing matrix job ends with one failed step *and* cancelled
 *   siblings, and it must still read as a failure), and a step that failed
 *   under `continue-on-error` (`stepConclusion`) is not a failure at all;
 * - then `waiting`/`running`;
 * - `succeeded` once every reached step is terminal — `skipped` only when
 *   every one of them was skipped **and none carried an `outputs` map**, since
 *   a `headless: skip` stands its declared outputs in for the work (07,
 *   Decision 11) and so *produced*. Without that clause the same workflow's
 *   item reads Skipped headless and Succeeded attended.
 */
function itemStatus(def: Definition, steps: StepState[]): StepStatus {
  if (steps.length === 0) return 'queued'
  if (steps.some((s) => stepConclusion(def, s) === 'failure')) return 'failed'
  if (steps.some((s) => s.status === 'cancelled')) return 'cancelled'
  if (steps.some((s) => s.status === 'waiting')) return 'waiting'
  if (steps.some((s) => s.status === 'running' || s.status === 'polling')) return 'running'
  if (steps.every((s) => isTerminal(s.status))) {
    return steps.every((s) => s.status === 'skipped') && !steps.some(skippedWithOutputs)
      ? 'skipped'
      : 'succeeded'
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

/**
 * How many of a matrix job's items are finished — the `N of M` the rail row and
 * the graph node both print, folded once here so the two counts cannot drift.
 * An item counts only when every declared step of it has a terminal row, the
 * same completeness `graph.jobComplete` asks about a whole job.
 */
export function itemsDone(def: Definition, state: RunState, job: string): number {
  return Array.from({ length: itemTotal(state, job) }).filter((_, i) =>
    stepsOfJob(def, state, job, i).every((r) => r.state !== undefined && isTerminal(r.state.status)),
  ).length
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
