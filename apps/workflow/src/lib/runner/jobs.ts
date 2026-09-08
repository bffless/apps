/**
 * Pure job-level readings of a run (spec 2026-09-08): what the rail, the job
 * head and the graph node all print, in one place so they cannot disagree.
 */
import type { Definition, RunState, Step, StepKey, StepState, StepStatus } from './types'
import { stepKey } from './types'

export function jobStatus(steps: StepState[]): StepStatus {
  if (steps.some((s) => s.status === 'failed')) return 'failed'
  if (steps.some((s) => s.status === 'cancelled')) return 'cancelled'
  if (steps.some((s) => s.status === 'waiting')) return 'waiting'
  if (steps.some((s) => s.status === 'running' || s.status === 'polling')) return 'running'
  if (steps.length > 0 && steps.every((s) => s.status === 'succeeded' || s.status === 'skipped')) {
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
