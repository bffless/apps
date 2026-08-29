/**
 * What a step declares about waiting: its `headless:` mode (07) and its
 * `timeout-minutes` budget (01/D13).
 *
 * Both are read straight off `step.raw` — the parsed YAML, not a typed model —
 * so this is the one place that knows their spellings and their defaults. It
 * exists because three modules that must agree were each reading them
 * separately: the graph chip (which shows the mode), the script launcher (which
 * times its Worker), and now the wait clock the middleware puts on `island` /
 * `form` steps (Decision 10). A disagreement between those readings would show
 * up as a step that displays one budget and enforces another.
 *
 * It also owns what a `headless: skip` *stands in for* — `evaluateSkipOutputs`
 * — because that is the same declaration read one level deeper, and the
 * middleware should not have to know its spelling either.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import { truthy } from '@bffless/workflow-lint/expressions'
import { buildContexts, evalDeep } from './contexts'
import { formFieldDefs, validateFormOutputs } from './adapters/form'
import { obj, outputDecls, validateDeclared } from './adapters/declared'
import type { StepScope } from './adapters/declared'
import type { Definition, Step } from './types'

export type HeadlessMode = 'skip' | 'auto'

/**
 * Whether "Don't wait for me" (07) has anything to apply to: at least one
 * `island`/`form` step declares `headless:`. A workflow with no interactive
 * steps, or whose interactive steps all wait for a person regardless, has no
 * toggle to offer — an unattended run of it would be an ordinary run.
 */
export function offersUnattended(def: Definition): boolean {
  return Object.values(def.jobs).some((job) =>
    job.steps.some(
      (step) => (step.uses === 'island' || step.uses === 'form') && headlessMode(step) !== undefined,
    ),
  )
}

/**
 * `headless: skip|auto` (bare form) or `headless: { mode: skip|auto, ... }`
 * (07) — `undefined` for a step that declares no `headless` at all. Defensive
 * on a headless block with no `mode`: the schema requires one, but `auto` is
 * the harness's own default if that ever slips through.
 */
export function headlessMode(step: Step): HeadlessMode | undefined {
  const h = step.raw?.headless as unknown
  if (h === 'skip' || h === 'auto') return h
  if (h !== null && typeof h === 'object') {
    const mode = (h as { mode?: unknown }).mode
    if (mode === 'skip' || mode === 'auto') return mode
    if (mode === undefined) return 'auto'
  }
  return undefined
}

/**
 * The step's own `auto-accept:` (07, apps#435): an expression the workflow
 * author put on an `island`/`form` step that, when truthy on an interactive
 * run, applies that one step's `headless:` declaration exactly as "Don't wait
 * for me" would — without touching the rest of the run. Evaluated when the
 * step is reached, against the same contexts its `if:` reads, so a kickoff
 * input (`${{ inputs.accept_cuts }}`) is the usual thing to put here and a
 * resumed run reads the answer straight off its persisted `inputs`.
 *
 * `false` for a step that declares none. A bare YAML boolean is honoured as
 * is; a string goes through the expression engine and GitHub truthiness. A
 * step without `headless:` has nothing for this to apply (the linter rejects
 * that shape), so it stays a no-op at runtime rather than a second decision.
 * Throws `EvalError` on a bad expression: the caller records that as the
 * step's failure, the way a bad `headless.outputs` is.
 */
export function autoAccept(a: StepScope): boolean {
  if (a.step.uses !== 'island' && a.step.uses !== 'form') return false
  const decl = ((a.step.raw ?? {}) as Record<string, unknown>)['auto-accept']
  if (decl === undefined || decl === null) return false
  if (typeof decl !== 'string') return truthy(decl)
  const contexts = buildContexts(a.def, a.state, { job: a.job, index: a.index, stepId: a.step.id })
  return truthy(evalDeep(decl, contexts))
}

/**
 * Whether this step runs as an unattended step (07): the person said so for
 * the whole run ("Don't wait for me"), or the step's own `auto-accept:` says
 * so for just this one. The driver's `headless` is deliberately *not* folded
 * in — a headless run reads the declarations on its own terms (it fails fast
 * on an undeclared step; this never does), so the two are kept apart at every
 * call site. Same `EvalError` contract as `autoAccept`.
 */
export function unattendedStep(a: StepScope): boolean {
  return a.state.unattended || autoAccept(a)
}

/** The step's declared `timeout-minutes` budget in ms, if it declared one (01). */
export function budgetMs(step: Step): number | undefined {
  const minutes = ((step.raw ?? {}) as Record<string, unknown>)['timeout-minutes']
  return typeof minutes === 'number' ? minutes * 60_000 : undefined
}

/**
 * What a headless run gives an `island`/`form` step that declared no budget of
 * its own (04/07: "default 5 in headless"). There is no equivalent for an
 * interactive run on purpose — a person is allowed to take as long as they
 * like, and a harness that timed them out would lose their work.
 */
export const HEADLESS_AUTO_DEFAULT_MS = 5 * 60_000

/**
 * How long a step may sit `waiting` before it fails (Decision 10). The declared
 * budget always wins — a workflow that says one minute means one minute whether
 * a person or CI is driving — and `undefined` means "no clock at all".
 */
export function waitBudgetMs(step: Step, headless: boolean): number | undefined {
  return budgetMs(step) ?? (headless ? HEADLESS_AUTO_DEFAULT_MS : undefined)
}

// ---------------------------------------------------------------------------
// What a `headless: skip` stands in for
// ---------------------------------------------------------------------------

export type SkipOutputs =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> }

/** The `outputs:` map inside a `headless:` block; `{}` for the bare `headless: skip` form. */
function skipDecls(step: Step): Record<string, unknown> {
  const h = step.raw?.headless as unknown
  return h !== null && typeof h === 'object' ? obj((h as { outputs?: unknown }).outputs) : {}
}

/**
 * A `headless: skip`'s declared outputs (07), evaluated against the run so far
 * and then checked against **the step's own declared map** — because that map
 * is the contract the rest of the workflow reads, and a skip that quietly
 * produced something else would be a run whose expressions mean one thing
 * attended and another unattended.
 *
 * Which map that is depends on the kind, and so does what an untyped
 * declaration means: a `form` step's declarations are its *evaluated* fields
 * (untyped meaning `string`, 02) — evaluated so a `choice` over
 * `${{ needs.card.outputs.posters }}` is checked against the tiles the form
 * would really have offered — and an `island` step's are its `outputs` map
 * (untyped meaning `json`). A form additionally goes through
 * `validateFormOutputs`, so a skip and a submit accept and record exactly the
 * same things, File refs included.
 *
 * Every declared name is evaluated even if an earlier one threw: the caller
 * reports all of them at once, the way a rejected submit reports every bad
 * field rather than the first.
 */
export function evaluateSkipOutputs(a: StepScope): SkipOutputs {
  const contexts = buildContexts(a.def, a.state, {
    job: a.job,
    index: a.index,
    stepId: a.step.id,
  })

  const values: Record<string, unknown> = {}
  const evalErrors: Record<string, string> = {}
  for (const [name, decl] of Object.entries(skipDecls(a.step))) {
    try {
      values[name] = evalDeep(decl, contexts)
    } catch (err) {
      evalErrors[name] = err instanceof Error ? err.message : String(err)
    }
  }

  const checked =
    a.step.uses === 'form'
      ? validateFormOutputs(formFieldDefs(a), values)
      : declaredOutputs(a.step, values)

  const errors = { ...(checked.ok ? {} : checked.errors), ...evalErrors }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return checked
}

/** The non-form half: an `island`'s declared `outputs` map, untyped meaning `json` (02). */
function declaredOutputs(step: Step, values: Record<string, unknown>): SkipOutputs {
  const { outputs, errors } = validateDeclared(outputDecls(step), values, { defaultType: 'json' })
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, outputs }
}
