/**
 * The declaration walk shared by the two *interactive* step adapters (`form`,
 * `island`): values arrive from outside the engine — a human's submit or an
 * island's `workflow.submit` — and must be checked against what the step
 * declares before they become outputs.
 *
 * A form declares `with.fields` and an island declares `outputs`, but the walk
 * is the same one either way (02): required, then the closed type vocabulary,
 * then the declaration's own constraint keys, and finally *drop* whatever the
 * step did not declare — the declaration is the contract the rest of the
 * workflow reads. The two differ only in where the declarations come from and
 * what an untyped declaration means, so those are the parameters here.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import type { InputDef } from '@bffless/workflow-lint/definition'
import { buildContexts } from '../contexts'
import { validateInputConstraints } from '../inputConstraints'
import { validateValue } from '../outputs'
import { evalAnnotations, evalSummary } from '../results'
import type { Definition, RunEvent, RunState, Step, StepKey } from '../types'

/** A JSON object view of an unknown value; anything else reads as `{}`. */
export function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** "Unanswered" for the purposes of `required` — `false` and `0` are answers. */
function blank(value: unknown, list: boolean): boolean {
  if (value === null || value === undefined || value === '') return true
  return list && Array.isArray(value) && value.length === 0
}

function article(type: string, list: boolean): string {
  return list ? `a list of ${type} values` : `a ${type} value`
}

export interface DeclaredResult {
  outputs: Record<string, unknown>
  errors: Record<string, string>
}

/**
 * Validate submitted `values` against a step's declarations.
 *
 * `defaultType` is what an untyped declaration means: `string` for a form field
 * (02's default field type), `json` for an island output (the vocabulary's
 * "anything"). A declaration given in the bare-string form is an *expression*
 * (02) — meaningful only where the harness computes the value, so here it reads
 * as "declared, untyped".
 *
 * NOTE (M2, flagged deviation): a declaration's `schema` key is accepted and
 * IGNORED. 02 specifies JSON-Schema validation as "one function over that
 * schema"; M2 validates the type/list shape only and defers the schema pass to
 * M3, so a `schema`-carrying output is type-checked but not structure-checked.
 */
export function validateDeclared(
  decls: Record<string, unknown>,
  values: Record<string, unknown>,
  options: { defaultType: string },
): DeclaredResult {
  const errors: Record<string, string> = {}
  const outputs: Record<string, unknown> = {}

  for (const [name, declared] of Object.entries(decls)) {
    const decl = typeof declared === 'string' ? {} : obj(declared)
    const type = typeof decl.type === 'string' ? decl.type : options.defaultType
    const list = decl.list === true
    // Anything not submitted is unanswered, not undefined: outputs are JSON.
    // `hasOwn` so a declaration named after an Object.prototype member cannot
    // pick the prototype's value up.
    const value =
      Object.hasOwn(values, name) && values[name] !== undefined ? values[name] : null

    if (decl.required === true && blank(value, list)) {
      errors[name] = 'This field is required'
      continue
    }
    if (!validateValue(type, list, value)) {
      errors[name] = `Expected ${article(type, list)}`
      continue
    }
    // The input-specific constraints (min/max, pattern, minLength/maxLength,
    // choice membership) that sit on top of the type (02): `validateValue`
    // above only checks the type-shape, so a declaration carrying those keys
    // means them wherever the value came from.
    const constraintError = validateInputConstraints({ ...decl, type } as InputDef, value)
    if (constraintError) {
      errors[name] = constraintError
      continue
    }
    outputs[name] = value
  }

  return { outputs, errors }
}

/** Where a step sits, everything the contexts need. */
export interface StepScope {
  step: Step
  key: StepKey
  job: string
  index: number
  def: Definition
  state: RunState
}

/**
 * The `step.succeeded` an accepted submit produces: the step's `summary` and
 * `annotations` templates evaluated with its own outputs in scope (01).
 *
 * `at` is the caller's clock, like every other event this layer builds — a
 * pure adapter reads no wall clock of its own (apps#370).
 */
export function succeededEvent(
  a: StepScope,
  outputs: Record<string, unknown>,
  at: number,
): Extract<RunEvent, { type: 'step.succeeded' }> {
  const contexts = buildContexts(a.def, a.state, {
    job: a.job,
    index: a.index,
    stepId: a.step.id,
    selfOutputs: outputs,
  })

  return {
    type: 'step.succeeded',
    key: a.key,
    outputs,
    summary: evalSummary(a.step, contexts),
    annotations: evalAnnotations(a.step, contexts),
    at,
  }
}
