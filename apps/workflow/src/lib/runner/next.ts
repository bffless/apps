/**
 * The scheduler (09): a pure selector over `(Definition, RunState)` that says
 * what should happen next — which jobs to expand, which steps to start, which
 * to write off as skipped, and when the run is over. It performs no effects;
 * the listener middleware hands each action to an adapter, and the adapter's
 * events come back through the reducer.
 *
 * Two invariants the rest of the engine leans on:
 * - a job is only scheduled once every `needs` job is **terminal**, so the
 *   status functions in `contexts.ts` are never asked about a job in flight;
 * - an action never proposes a step key that already has state — `step.queued`
 *   and `step.skipped` on an existing key are illegal transitions (reducer).
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import { buildContexts, buildJobContexts, evalIf, statusFns, stepConclusion } from './contexts'
import { expandMatrix, isTerminal, jobOrder, jobResult } from './graph'
import type { Definition, RunState, Step, StepKey, StepKind, StepStatus } from './types'
import { stepKey } from './types'

export interface SkipTarget {
  key: StepKey
  job: string
  index: number
  stepId: string
  stepKind: StepKind
}

export type NextAction =
  | { kind: 'expand'; job: string; total: number; items: Record<string, unknown>[] }
  | { kind: 'skip'; steps: SkipTarget[] }
  | { kind: 'start'; key: StepKey; job: string; index: number; stepId: string }
  | { kind: 'finish'; status: 'succeeded' | 'failed' }

const TERMINAL_STEP: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
])

/** The `if:` of a step, as written (undefined ⇒ the default `success()`). */
function stepIf(step: Step): string | undefined {
  const raw = step.raw as Record<string, unknown> | undefined
  return typeof raw?.if === 'string' ? raw.if : undefined
}

function strategy(def: Definition, job: string): Record<string, unknown> {
  const raw = def.jobs[job]?.raw as Record<string, unknown> | undefined
  const value = raw?.strategy
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** `strategy.max-parallel`; unlimited by default (01). */
function maxParallel(def: Definition, job: string): number {
  const value = strategy(def, job)['max-parallel']
  return typeof value === 'number' && value > 0 ? value : Number.POSITIVE_INFINITY
}

/** `strategy.fail-fast`; true by default (01). */
function failFast(def: Definition, job: string): boolean {
  return strategy(def, job)['fail-fast'] !== false
}

function target(job: string, index: number, step: Step): SkipTarget {
  return { key: stepKey(job, index, step.id), job, index, stepId: step.id, stepKind: step.uses }
}

interface ItemView {
  index: number
  /** Declared steps that have no state yet, in declaration order. */
  pending: Step[]
  /** The next step to consider — the first with no state. */
  next?: Step
  /** At least one step has state (the item has been picked up). */
  started: boolean
  /** A step is still in flight, so nothing else may happen in this item. */
  active: boolean
  /** Every declared step is terminal. */
  complete: boolean
  /** A step failed and was *not* tolerated by continue-on-error. */
  failed: boolean
}

function itemView(def: Definition, state: RunState, job: string, index: number): ItemView {
  const steps = def.jobs[job]?.steps ?? []
  const pending: Step[] = []
  let started = false
  let active = false
  let failed = false

  for (const step of steps) {
    const s = state.steps[stepKey(job, index, step.id)]
    if (!s) {
      pending.push(step)
      continue
    }
    started = true
    if (!TERMINAL_STEP.has(s.status)) active = true
    if (stepConclusion(def, s) === 'failure') failed = true
  }

  return { index, pending, next: pending[0], started, active, complete: !active && pending.length === 0, failed }
}

/** Every step of the job that has no state yet, item-major then declaration order. */
function unwritten(def: Definition, state: RunState, job: string, total: number): SkipTarget[] {
  const out: SkipTarget[] = []
  for (let index = 0; index < total; index++) {
    for (const step of def.jobs[job]?.steps ?? []) {
      if (!state.steps[stepKey(job, index, step.id)]) out.push(target(job, index, step))
    }
  }
  return out
}

/** Advance one job whose needs are satisfied, its matrix expanded and its `if` true. */
function scheduleItems(
  def: Definition,
  state: RunState,
  job: string,
  total: number,
): NextAction[] {
  const actions: NextAction[] = []
  const views: ItemView[] = []
  for (let index = 0; index < total; index++) views.push(itemView(def, state, job, index))

  // `fail-fast` (default): once an item has really failed, the items that never
  // started are written off. Items already in flight are left to finish — the
  // scheduler starts work, it does not abort it (a run-level cancel does that).
  const written = new Set<number>()
  if (failFast(def, job) && views.some((v) => v.failed)) {
    const steps = views
      .filter((v) => !v.started)
      .flatMap((v) => {
        written.add(v.index)
        return v.pending.map((step) => target(job, v.index, step))
      })
    if (steps.length > 0) actions.push({ kind: 'skip', steps })
  }

  // `max-parallel` bounds how many items are open at once; an item that is
  // merely between two steps already holds its slot.
  let slots = maxParallel(def, job) - views.filter((v) => v.started && !v.complete).length

  for (const view of views) {
    if (view.complete || view.active || written.has(view.index)) continue
    const step = view.next
    if (!step) continue
    if (!view.started) {
      if (slots <= 0) continue
      slots -= 1
    }

    const enabled = evalIf(
      stepIf(step),
      buildContexts(def, state, { job, index: view.index, stepId: step.id }),
      statusFns(def, state, { job, index: view.index, beforeStep: step.id }),
    )
    actions.push(
      enabled
        ? { kind: 'start', key: stepKey(job, view.index, step.id), job, index: view.index, stepId: step.id }
        : { kind: 'skip', steps: [target(job, view.index, step)] },
    )
  }
  return actions
}

/**
 * What to do next, in a deterministic order: topo layer, then job id, then
 * matrix index, then step declaration order. Returns `[]` for a run that is no
 * longer `running` — a finished or cancelled run schedules nothing.
 */
export function nextActions(def: Definition, state: RunState): NextAction[] {
  if (state.status !== 'running') return []

  const order = jobOrder(def)
  const actions: NextAction[] = []
  let allTerminal = true

  for (const job of order) {
    if (isTerminal(jobResult(def, state, job))) continue
    allTerminal = false

    const decl = def.jobs[job]
    if (!decl) continue

    // A need that is skipped or failed is *terminal but not success*: the job
    // still gets its turn, and its `if` decides (the default `success()` skips
    // it, `always()`/`failure()` opt back in).
    if (!decl.needs.every((need) => isTerminal(jobResult(def, state, need)))) continue

    const expansion = state.expansions[job]
    if (!expansion) {
      const { total, items } = expandMatrix(decl, buildJobContexts(def, state, job))
      actions.push({ kind: 'expand', job, total, items })
      continue
    }

    const enabled = evalIf(
      decl.if,
      buildJobContexts(def, state, job),
      statusFns(def, state, { job }),
    )
    if (!enabled) {
      // The record wants a row per step even for a job that never ran (05), and
      // an all-skipped job is how `RunState` spells the job result `skipped`.
      const steps = unwritten(def, state, job, expansion.total)
      if (steps.length > 0) actions.push({ kind: 'skip', steps })
      continue
    }

    actions.push(...scheduleItems(def, state, job, expansion.total))
  }

  if (actions.length === 0 && allTerminal) {
    const failed = order.some((job) => jobResult(def, state, job) === 'failure')
    actions.push({ kind: 'finish', status: failed ? 'failed' : 'succeeded' })
  }
  return actions
}
