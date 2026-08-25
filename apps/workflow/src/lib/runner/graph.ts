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
import { scanTemplates } from '@bffless/workflow-lint/expressions'
import type { Expr } from '@bffless/workflow-lint/expressions'
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
 * The dotted chain an expression node reads, or nothing when it is not a plain
 * reference. A dynamic `[expr]` segment ends the chain as unusable (`null`),
 * which is enough: a reference whose subject is computed names no single
 * upstream value, and the panes label values, not possibilities.
 */
function chainOf(e: Expr): { root: string; path: (string | null)[] } | undefined {
  if (e.kind === 'ident') return { root: e.name, path: [] }
  if (e.kind === 'member') {
    const c = chainOf(e.object)
    return c && { root: c.root, path: [...c.path, e.property] }
  }
  if (e.kind === 'index') {
    const c = chainOf(e.object)
    if (!c) return undefined
    const idx = e.index
    const seg = idx.kind === 'string' ? idx.value : idx.kind === 'number' ? String(idx.value) : null
    return { root: c.root, path: [...c.path, seg] }
  }
  return undefined
}

/** `steps.<id>.outputs.<o>` / `needs.<job>.outputs.<o>` / `inputs.<name>`, or nothing. */
function refOf(e: Expr): ValueRef | undefined {
  const chain = chainOf(e)
  if (!chain || !REF_ROOTS.has(chain.root)) return undefined
  const [name, kind, output] = chain.path
  if (typeof name !== 'string') return undefined
  if (chain.root === 'inputs') return { context: 'inputs', name }
  // `steps.boom.error.code` and `needs.greet.result` are control flow, not data.
  if (kind !== 'outputs' || typeof output !== 'string') return undefined
  return { context: chain.root as 'steps' | 'needs', name, output }
}

/** Every reference in one expression tree, in source order. */
function collect(e: Expr, into: ValueRef[]): void {
  switch (e.kind) {
    case 'ident':
    case 'member':
    case 'index': {
      const ref = refOf(e)
      if (ref) into.push(ref)
      // A dynamic index carries its own references, whatever the chain did.
      for (let cur: Expr = e; cur.kind === 'member' || cur.kind === 'index'; cur = cur.object) {
        if (cur.kind === 'index' && cur.index.kind !== 'string' && cur.index.kind !== 'number') {
          collect(cur.index, into)
        }
      }
      break
    }
    case 'call':
      for (const arg of e.args) collect(arg, into)
      break
    case 'not':
      collect(e.operand, into)
      break
    case 'binary':
      collect(e.left, into)
      collect(e.right, into)
      break
    default:
      break
  }
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
        if (span.expr) collect(span.expr, refs)
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
