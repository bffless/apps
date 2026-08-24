/**
 * The expression contexts of 01-workflow-yaml.md, built for one evaluation site.
 *
 * Every value the harness evaluates — `with`, `body`, `if`, `summary`, job and
 * top-level `outputs` — goes through here and then through the *shared*
 * expression engine in `@bffless/workflow-lint` (the linter checks the same
 * grammar against the same context table, so a run cannot disagree with a lint).
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import {
  EvalError,
  evaluate,
  isSingleExpression,
  parseExpression,
  parseIfExpression,
  renderTemplate,
  truthy,
  type EvalOptions,
} from '@bffless/workflow-lint/expressions'
import type { OutputDecl } from '@bffless/workflow-lint/definition'
import type { Definition, RunState, StepError, StepState, StepStatus } from './types'
import { stepKey } from './types'

type Status = NonNullable<EvalOptions['status']>
/** Terminal step/job result as read by `steps.<id>.outcome` / `needs.<job>.result`. */
export type Outcome = 'success' | 'failure' | 'skipped' | 'cancelled'

export interface CtxScope {
  job: string
  index: number
  stepId?: string
  attempt?: number
  /** step-local overlays for pipeline slots (01 contexts table) */
  response?: unknown
  error?: StepError
  /** own outputs, readable in the step's own summary/annotations */
  selfOutputs?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Evaluation entry points
// ---------------------------------------------------------------------------

/** Evaluate a string that may be a template; single expression keeps type. */
export function evalValue(
  raw: string,
  contexts: Record<string, unknown>,
  status?: EvalOptions['status'],
): unknown {
  const opts: EvalOptions = { contexts, status }
  if (isSingleExpression(raw)) {
    const trimmed = raw.trim()
    return evaluate(parseExpression(trimmed.slice(3, -2)), opts)
  }
  return renderTemplate(raw, opts)
}

/** Deep-evaluate every string scalar in a JSON value; single-expression scalars keep their type (01). */
export function evalDeep(value: unknown, contexts: Record<string, unknown>): unknown {
  if (typeof value === 'string') return evalValue(value, contexts)
  if (Array.isArray(value)) return value.map((v) => evalDeep(v, contexts))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = evalDeep(v, contexts)
    }
    return out
  }
  return value
}

/** GitHub `if` semantics: undefined → success(); bare string parsed whole (parseIfExpression). */
export function evalIf(
  expr: string | undefined,
  contexts: Record<string, unknown>,
  status: Status,
): boolean {
  if (expr === undefined) return status.success()
  const parsed = parseIfExpression(expr)
  if (parsed.error) throw new EvalError(parsed.error.message)
  if (parsed.expr) return truthy(evaluate(parsed.expr, { contexts, status }))
  // A mix of literal text and `${{ }}` spans: interpolate, then apply truthiness.
  return truthy(renderTemplate(expr, { contexts, status }))
}

// ---------------------------------------------------------------------------
// Step-level helpers
// ---------------------------------------------------------------------------

const OUTCOMES: Partial<Record<StepStatus, Outcome>> = {
  succeeded: 'success',
  failed: 'failure',
  skipped: 'skipped',
  cancelled: 'cancelled',
}

/** Position of a step within its job's `steps:` list; -1 when unknown. */
function stepPos(def: Definition, job: string, stepId: string): number {
  return def.jobs[job]?.steps.findIndex((s) => s.id === stepId) ?? -1
}

function continueOnError(def: Definition, job: string, stepId: string): boolean {
  const raw = def.jobs[job]?.steps.find((s) => s.id === stepId)?.raw as
    | Record<string, unknown>
    | undefined
  return raw?.['continue-on-error'] === true
}

/** Raw terminal status; null while the step is still in flight. */
function outcomeOf(s: StepState): Outcome | null {
  return OUTCOMES[s.status] ?? null
}

/**
 * As `outcome`, but `success` when the failure was tolerated by continue-on-error (01).
 *
 * Exported because the scheduler (`next.ts`) asks the same question — "did this
 * item really fail?" — and a second reading of `continue-on-error` would be a
 * second source of truth.
 */
export function stepConclusion(def: Definition, s: StepState): Outcome | null {
  const outcome = outcomeOf(s)
  if (outcome === 'failure' && continueOnError(def, s.job, s.stepId)) return 'success'
  return outcome
}

/** Steps of one matrix item, in `steps:` declaration order. */
function itemSteps(def: Definition, state: RunState, job: string, index: number): StepState[] {
  return Object.values(state.steps)
    .filter((s) => s.job === job && s.index === index)
    .sort((a, b) => stepPos(def, job, a.stepId) - stepPos(def, job, b.stepId))
}

function stepEntry(def: Definition, s: StepState): Record<string, unknown> {
  return {
    outputs: s.outputs ?? null,
    outcome: outcomeOf(s),
    conclusion: stepConclusion(def, s),
    error: s.error ?? null,
    response: s.response ?? null,
  }
}

// ---------------------------------------------------------------------------
// Job results and job outputs
// ---------------------------------------------------------------------------

/**
 * The *terminal* job result as `needs.<job>.result` / `jobs.<job>.result` see it.
 *
 * The single implementation: `graph.jobResult` is the scheduler's richer view
 * (it also reports `pending`/`running`) and delegates here once the job is
 * complete, so a run's schedule and its expressions can never disagree about
 * whether a job succeeded. The dependency runs graph → contexts (contexts never
 * imports graph), which keeps the pair acyclic.
 *
 * Only meaningful for a job whose steps are all terminal — the scheduler never
 * asks for a need that is still running (see `graph.isTerminal`).
 */
export function jobOutcome(def: Definition, state: RunState, job: string): Outcome {
  const states = Object.values(state.steps).filter((s) => s.job === job)
  if (states.length === 0) return 'skipped'
  // `failure` outranks `cancelled`: with the default `fail-fast: true` a failing
  // matrix job ends with one failed step *and* cancelled siblings (01), and the
  // run — plus any downstream `if: failure()` — must still see a failure.
  if (states.some((s) => stepConclusion(def, s) === 'failure')) return 'failure'
  if (states.some((s) => s.status === 'cancelled')) return 'cancelled'
  if (states.every((s) => s.status === 'skipped')) return 'skipped'
  return 'success'
}

/** A matrix item contributes an output only when it ran and did not fail. */
function itemProduced(def: Definition, state: RunState, job: string, index: number): boolean {
  const states = itemSteps(def, state, job, index)
  if (states.length === 0) return false
  if (states.some((s) => s.status === 'cancelled')) return false
  return !states.some((s) => stepConclusion(def, s) === 'failure')
}

/**
 * Both `OutputDecl` forms: a bare expression string, or `{ type?, value }`.
 * Exported for the top-level `outputs:` evaluation on `run.finished`
 * (`store/runnerMiddleware.ts`, Task 17) — the same rule job outputs use, so
 * there is exactly one reading of an `OutputDecl`.
 */
export function evalOutputDecl(decl: OutputDecl, contexts: Record<string, unknown>): unknown {
  if (typeof decl === 'string') return evalValue(decl, contexts)
  if (decl.value === undefined) return null
  return evalDeep(decl.value, contexts)
}

/**
 * Job outputs, evaluated lazily against that job's own contexts. A matrix job's
 * outputs collect into lists in matrix order (01 Deviation); an item that never
 * ran or failed contributes `null`.
 */
function jobOutputs(
  def: Definition,
  state: RunState,
  job: string,
  stack: Set<string>,
): Record<string, unknown> {
  const decl = def.jobs[job]
  const out: Record<string, unknown> = {}
  if (!decl) return out
  const total = state.expansions[job]?.total ?? 1
  for (const [name, value] of Object.entries(decl.outputs)) {
    if (decl.matrix) {
      const list: unknown[] = []
      for (let i = 0; i < total; i++) {
        list.push(
          itemProduced(def, state, job, i)
            ? evalOutputDecl(value, jobContexts(def, state, job, i, stack))
            : null,
        )
      }
      out[name] = list
    } else {
      out[name] = evalOutputDecl(value, jobContexts(def, state, job, 0, stack))
    }
  }
  return out
}

/** `{ outputs, result }` — the shape behind both `needs.<job>` and `jobs.<job>`. */
function jobRef(
  def: Definition,
  state: RunState,
  job: string,
  stack: Set<string>,
): { outputs: Record<string, unknown> | null; result: Outcome } {
  const result = jobOutcome(def, state, job)
  // Outputs of a job that was skipped, failed or cancelled are null (01).
  // `stack` guards against a definition that (illegally) cycles through needs.
  if (result !== 'success' || stack.has(job)) return { outputs: null, result }
  stack.add(job)
  try {
    return { outputs: jobOutputs(def, state, job, stack), result }
  } finally {
    stack.delete(job)
  }
}

function needsCtx(
  def: Definition,
  state: RunState,
  job: string,
  stack: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const need of def.jobs[job]?.needs ?? []) out[need] = jobRef(def, state, need, stack)
  return out
}

// ---------------------------------------------------------------------------
// Contexts available everywhere
// ---------------------------------------------------------------------------

/** `workflows/<impl>/<workflow>/runs/<run-id>` (06). */
function runPrefix(state: RunState): string {
  return `workflows/${state.impl}/${state.workflow}/runs/${state.runId}`
}

function ambientCtx(state: RunState): Record<string, unknown> {
  return {
    inputs: state.inputs,
    run: {
      id: state.runId,
      prefix: runPrefix(state),
      started_by: state.startedBy ?? null,
      started_at: state.startedAt,
      headless: state.headless,
    },
    impl: { alias: state.impl, base: `/w/${state.impl}`, api: `/api/${state.impl}` },
  }
}

// ---------------------------------------------------------------------------
// The three context builders
// ---------------------------------------------------------------------------

/**
 * Contexts for a job/matrix-item site, with every step of the item visible —
 * what job `outputs` read. `buildContexts` narrows `steps` to the steps that
 * precede the evaluation site.
 */
function jobContexts(
  def: Definition,
  state: RunState,
  job: string,
  index: number,
  stack: Set<string>,
  beforePos = Number.POSITIVE_INFINITY,
): Record<string, unknown> {
  const steps: Record<string, unknown> = {}
  for (const s of itemSteps(def, state, job, index)) {
    const pos = stepPos(def, job, s.stepId)
    if (pos >= 0 && pos < beforePos) steps[s.stepId] = stepEntry(def, s)
  }
  const expansion = state.expansions[job]
  return {
    ...ambientCtx(state),
    needs: needsCtx(def, state, job, stack),
    steps,
    matrix: expansion?.items[index] ?? {},
    strategy: { 'job-index': index, 'job-total': expansion?.total ?? 1 },
  }
}

/** Contexts for job-level slots (job if, matrix expr, job outputs). */
export function buildJobContexts(
  def: Definition,
  state: RunState,
  job: string,
  index = 0,
): Record<string, unknown> {
  return jobContexts(def, state, job, index, new Set())
}

/** The 01 contexts table for one evaluation site. */
export function buildContexts(
  def: Definition,
  state: RunState,
  scope: CtxScope,
): Record<string, unknown> {
  const pos = scope.stepId ? stepPos(def, scope.job, scope.stepId) : -1
  const ctx = jobContexts(
    def,
    state,
    scope.job,
    scope.index,
    new Set(),
    pos >= 0 ? pos : Number.POSITIVE_INFINITY,
  )

  if (!scope.stepId) return ctx

  const key = stepKey(scope.job, scope.index, scope.stepId)
  const own = state.steps[key]
  // A step reads its own outputs only in its own summary/annotations (01).
  if (scope.selfOutputs) {
    const steps = ctx.steps as Record<string, unknown>
    const base = own
      ? stepEntry(def, own)
      : { outcome: null, conclusion: null, error: null, response: null }
    steps[scope.stepId] = { ...base, outputs: scope.selfOutputs }
  }

  // `error`: the step's own last failure, else the last failed step of this item.
  let lastError: StepError | null = scope.error ?? null
  if (!lastError) {
    for (const s of itemSteps(def, state, scope.job, scope.index)) {
      const p = stepPos(def, scope.job, s.stepId)
      if (p >= 0 && (pos < 0 || p < pos) && s.status === 'failed' && s.error) lastError = s.error
    }
  }

  return {
    ...ctx,
    response: scope.response ?? null,
    error: lastError,
    step: {
      key,
      prefix: `${runPrefix(state)}/${key}`,
      attempt: scope.attempt ?? own?.attempt ?? 1,
    },
  }
}

/** Contexts for top-level outputs (adds `jobs`). */
export function buildRunContexts(def: Definition, state: RunState): Record<string, unknown> {
  const jobs: Record<string, unknown> = {}
  for (const job of Object.keys(def.jobs)) jobs[job] = jobRef(def, state, job, new Set())
  return { ...ambientCtx(state), jobs }
}

// ---------------------------------------------------------------------------
// Status functions
// ---------------------------------------------------------------------------

/**
 * success()/failure()/always()/cancelled() for a job-`if` or step-`if` site.
 *
 * GitHub scopes the first two to the **site**, and so do we:
 * - a **job** `if` (no `beforeStep`) asks about `needs` — the default `if` is
 *   `success()`, which is exactly "every need succeeded";
 * - a **step** `if` asks about *this job so far* — has an earlier step of this
 *   matrix item failed untolerated? The needs already decided whether the job
 *   runs at all, so a job that opted in with `always()`/`failure()` after a
 *   failed need must still run its own default-`if` steps.
 */
export function statusFns(
  def: Definition,
  state: RunState,
  scope: { job: string; index?: number; beforeStep?: string },
): Status {
  const needs = def.jobs[scope.job]?.needs ?? []
  const needResults = () => needs.map((n) => jobOutcome(def, state, n))

  const earlierFailed = (): boolean => {
    if (!scope.beforeStep) return false
    const pos = stepPos(def, scope.job, scope.beforeStep)
    if (pos < 0) return false
    return itemSteps(def, state, scope.job, scope.index ?? 0).some(
      (s) =>
        stepPos(def, scope.job, s.stepId) < pos && stepConclusion(def, s) === 'failure',
    )
  }

  const atStep = scope.beforeStep !== undefined

  return {
    success: () => (atStep ? !earlierFailed() : needResults().every((r) => r === 'success')),
    failure: () => (atStep ? earlierFailed() : needResults().some((r) => r === 'failure')),
    always: () => true,
    cancelled: () => state.status === 'cancelled',
  }
}
