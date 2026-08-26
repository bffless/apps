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
import { collectRefs, scanTemplates } from '@bffless/workflow-lint/expressions'
import type { Ref } from '@bffless/workflow-lint/expressions'
import { evalDeep, jobOutcome } from './contexts'
import type { Definition, Job, RunState, StepKey, StepState, StepStatus } from './types'
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

/**
 * The first step (that has a state) satisfying `pred`, in scheduling order —
 * topo job order, then declaration order, then matrix index. `null` when none
 * does. The one walk every "which step does the page open" question shares,
 * so they cannot disagree about order (apps#370).
 */
export function firstStepWhere(
  def: Definition,
  state: RunState,
  pred: (step: StepState) => boolean,
): StepKey | null {
  for (const job of jobOrder(def)) {
    const steps = def.jobs[job]?.steps ?? []
    const total = state.expansions[job]?.total ?? 1
    for (const step of steps) {
      for (let index = 0; index < total; index++) {
        const key = stepKey(job, index, step.id)
        const current = state.steps[key]
        if (current && pred(current)) return key
      }
    }
  }
  return null
}

/**
 * The first step whose current status is `waiting`, in scheduling order, so a
 * form the run just parked on is the one the run page opens (08: "the pane is
 * the form"). `null` when nothing is waiting.
 */
export function firstWaitingStep(def: Definition, state: RunState): StepKey | null {
  return firstStepWhere(def, state, (step) => step.status === 'waiting')
}

/** "k of n done" (08): terminal steps against every step the run currently knows about. */
export function stepProgress(state: RunState): { done: number; total: number } {
  const steps = Object.values(state.steps)
  return { done: steps.filter((s) => TERMINAL_STEP.has(s.status)).length, total: steps.length }
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

// ---------------------------------------------------------------------------
// Data-flow references
// ---------------------------------------------------------------------------

/** One upstream value an expression reads: `steps.say.outputs.line` → say/line. */
export interface ValueRef {
  context: 'steps' | 'needs' | 'inputs'
  /** The step id, the job id, or the input name. */
  name: string
  /** The declared output read off it; absent for `inputs`. */
  output?: string
}

const REF_ROOTS: ReadonlySet<string> = new Set(['steps', 'needs', 'inputs'])

/**
 * `steps.<id>.outputs.<o>` / `needs.<job>.outputs.<o>` / `inputs.<name>`, or
 * nothing — from lint's own `Ref { root, path }` (a dynamic `[expr]` segment
 * comes through as a `null` path entry, which is enough: a reference whose
 * subject is computed names no single upstream value, and the panes label
 * values, not possibilities).
 */
function toValueRef(ref: Ref): ValueRef | undefined {
  if (!REF_ROOTS.has(ref.root)) return undefined
  const [name, kind, output] = ref.path
  if (typeof name !== 'string') return undefined
  if (ref.root === 'inputs') return { context: 'inputs', name }
  // `steps.boom.error.code` and `needs.greet.result` are control flow, not data.
  if (kind !== 'outputs' || typeof output !== 'string') return undefined
  return { context: ref.root as 'steps' | 'needs', name, output }
}

/**
 * The upstream values a declaration reads — every `${{ … }}` in every string
 * scalar of `raw`, de-duplicated, in encounter order. This is what the step
 * panes' "from …" labels are built from (08); the hover-highlight the same
 * edges would drive is M2.
 *
 * Never throws: an expression that does not parse is simply not a reference,
 * because this runs on definitions the linter has already reported on.
 */
export function refsIn(raw: unknown): ValueRef[] {
  const refs: ValueRef[] = []
  const seen = new Set<string>()

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const span of scanTemplates(value)) {
        if (!span.expr) continue
        for (const ref of collectRefs(span.expr).refs) {
          const mapped = toValueRef(ref)
          if (mapped) refs.push(mapped)
        }
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item)
    }
  }

  walk(raw)
  return refs.filter((ref) => {
    const id = `${ref.context}.${ref.name}.${ref.output ?? ''}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** A directed data-flow edge: the value a step reads, and the step that reads it. */
export interface DataFlowEdge {
  from: { job: string; step?: string; output: string }
  to: { job: string; step: string }
}

/**
 * The fields whose expressions are read for data-flow edges (08's
 * hover-highlight) — the ones a step's own pane shows (Input/Output/Details'
 * summary and annotations). `poll`/`retry` are control flow over `response`/
 * `error`, not upstream data, and `headless` is the escape hatch a headless
 * run takes instead of the interactive path this highlight is drawn for.
 */
const FLOW_FIELDS = ['with', 'if', 'outputs', 'summary', 'annotations'] as const

/**
 * Every step-held expression's upstream reference, as an edge from the value
 * it reads to the step that reads it. Only STEP-held expressions produce
 * edges: a job's own `outputs` are aliases evaluated at the job boundary, not
 * a step's expression, so they contribute none of their own — a downstream
 * job still lights up because *it* reads `needs.<job>.outputs.*` directly.
 */
export function dataFlowEdges(def: Definition): DataFlowEdge[] {
  const edges: DataFlowEdge[] = []
  for (const job of Object.values(def.jobs)) {
    for (const step of job.steps) {
      const to = { job: job.id, step: step.id }
      for (const field of FLOW_FIELDS) {
        for (const ref of refsIn((step.raw as Record<string, unknown> | undefined)?.[field])) {
          if (ref.context === 'needs') {
            edges.push({ from: { job: ref.name, output: ref.output! }, to })
          } else if (ref.context === 'steps') {
            edges.push({ from: { job: job.id, step: ref.name, output: ref.output! }, to })
          }
        }
      }
    }
  }
  return edges
}
