/**
 * The job DAG (09): topological layering for the run canvas, matrix expansion,
 * and the job-level result that both the scheduler (`next.ts`) and the UI read.
 *
 * The job *result* has exactly one implementation: the terminal half lives in
 * `contexts.jobOutcome` (it is what `needs.<job>.result` reports), and this
 * module wraps it with the two non-terminal states a scheduler also needs.
 * The dependency runs graph → contexts, never the other way, so the pair stays
 * acyclic.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import { evalDeep, jobOutcome } from './contexts'
import type { Definition, Job, RunState, StepStatus } from './types'
import { stepKey } from './types'

export type JobResult = 'pending' | 'running' | 'success' | 'failure' | 'skipped' | 'cancelled'

export interface FlowEdge {
  fromJob: string
  toJob: string
  kind: 'needs'
}

const TERMINAL_STEP: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
])

const TERMINAL_JOB: ReadonlySet<JobResult> = new Set<JobResult>([
  'success',
  'failure',
  'skipped',
  'cancelled',
])

/** A job the scheduler is done with: its needs-gate answer can no longer change. */
export function isTerminal(result: JobResult): boolean {
  return TERMINAL_JOB.has(result)
}

/** `needs` restricted to jobs this workflow actually declares (dangling refs are a lint error). */
function declaredNeeds(def: Definition, job: string): string[] {
  return (def.jobs[job]?.needs ?? []).filter((n) => n in def.jobs)
}

/**
 * Kahn layering: layer 0 is every job with no needs, layer n every job whose
 * needs all sit in earlier layers. Jobs inside a layer are ordered by id, which
 * is what makes the whole schedule deterministic (layer, then job, then index).
 * A cycle is unschedulable and throws (the linter reports it first).
 */
export function topoLayers(def: Definition): string[][] {
  const layers: string[][] = []
  const placed = new Set<string>()
  let remaining = Object.keys(def.jobs)

  while (remaining.length > 0) {
    const layer = remaining
      .filter((id) => declaredNeeds(def, id).every((n) => placed.has(n)))
      .sort()
    if (layer.length === 0) {
      throw new Error(`Cycle in the job graph: ${[...remaining].sort().join(', ')}`)
    }
    layers.push(layer)
    for (const id of layer) placed.add(id)
    remaining = remaining.filter((id) => !placed.has(id))
  }
  return layers
}

/** Every job id in scheduling order — topo layer, then job id. */
export function jobOrder(def: Definition): string[] {
  return topoLayers(def).flat()
}

/** The `needs` edges, for the run canvas. */
export function needsEdges(def: Definition): FlowEdge[] {
  const edges: FlowEdge[] = []
  for (const id of Object.keys(def.jobs)) {
    for (const need of declaredNeeds(def, id)) {
      edges.push({ fromJob: need, toJob: id, kind: 'needs' })
    }
  }
  return edges
}

/**
 * Fan a job out into matrix items (01). One item per combination, the last
 * variable varying fastest; a job with no `strategy.matrix` is one empty item.
 * A variable that evaluates to nothing contributes no items, so the job ends up
 * with `total: 0` and — having no steps to run — reads as `skipped`.
 */
export function expandMatrix(
  job: Job,
  contexts: Record<string, unknown>,
): { total: number; items: Record<string, unknown>[] } {
  if (!job.matrix) return { total: 1, items: [{}] }

  let items: Record<string, unknown>[] = [{}]
  for (const [name, decl] of Object.entries(job.matrix)) {
    const value = evalDeep(decl, contexts)
    const list = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]
    const next: Record<string, unknown>[] = []
    for (const item of items) {
      for (const v of list) next.push({ ...item, [name]: v })
    }
    items = next
  }
  return { total: items.length, items }
}

/** True once every declared step of every matrix item has reached a terminal status. */
function jobComplete(def: Definition, state: RunState, job: string, total: number): boolean {
  const steps = def.jobs[job]?.steps ?? []
  for (let index = 0; index < total; index++) {
    for (const step of steps) {
      const s = state.steps[stepKey(job, index, step.id)]
      if (!s || !TERMINAL_STEP.has(s.status)) return false
    }
  }
  return true
}

/**
 * The scheduler's view of a job: `pending` before it is picked up, `running`
 * while any of its steps are still to come, then whatever `needs.<job>.result`
 * would say.
 */
export function jobResult(def: Definition, state: RunState, job: string): JobResult {
  if (!(job in def.jobs)) return 'pending'
  const expansion = state.expansions[job]
  if (!expansion) {
    return Object.values(state.steps).some((s) => s.job === job) ? 'running' : 'pending'
  }
  if (!jobComplete(def, state, job, expansion.total)) return 'running'
  return jobOutcome(def, state, job)
}
