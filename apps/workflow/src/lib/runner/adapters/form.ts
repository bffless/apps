/**
 * The `form` step adapter (03): the built-in schema-driven form, used mid-run.
 *
 * A form step has no `outputs` map — **the field values are the outputs**,
 * typed by their own definitions (02/03) — so this module is exactly two
 * functions: the initial values the form UI opens with (defaults may be
 * expressions, which is how an upstream output becomes an editable field), and
 * the validation + `step.succeeded` event a submit produces. Both halves of
 * that second function are the declaration walk shared with the island adapter
 * (`./declared`); a form's declarations are its fields, untyped meaning
 * `string` (02).
 *
 * Unlike the pipeline adapter there is nothing asynchronous here and no
 * effects: the caller emits the returned event. Rejected input comes back as
 * per-field messages, never as a throw.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import type { InputDef } from '@bffless/workflow-lint/definition'
import { evalDeep, buildContexts } from '../contexts'
import type { Definition, RunEvent, RunState, Step, StepKey } from '../types'
import { obj, succeededEvent, validateDeclared } from './declared'

/** `with.fields` — the field definitions, which double as the output types. */
function fieldsOf(step: Step): Record<string, InputDef> {
  return obj(obj(obj(step.raw).with).fields) as Record<string, InputDef>
}

export interface FormStepArgs {
  step: Step
  key: StepKey
  job: string
  index: number
  def: Definition
  state: RunState
  values: Record<string, unknown>
  /** The caller's clock — the `at` the `step.succeeded` is stamped with. */
  at: number
}

export type FormResult =
  | { ok: true; event: Extract<RunEvent, { type: 'step.succeeded' }> }
  | { ok: false; errors: Record<string, string> }

/** Validate submitted field values against the form's field defs; evaluate summary/annotations. */
export function completeFormStep(a: FormStepArgs): FormResult {
  // A form's fields *are* its declarations; an untyped field is a string (02).
  const { outputs, errors } = validateDeclared(fieldsOf(a.step), a.values, {
    defaultType: 'string',
  })

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return { ok: true, event: succeededEvent(a, outputs, a.at) }
}

/** Evaluated initial field values (expression defaults) for the form UI. */
export function formInitialValues(a: {
  step: Step
  def: Definition
  state: RunState
  job: string
  index: number
}): Record<string, unknown> {
  const contexts = buildContexts(a.def, a.state, {
    job: a.job,
    index: a.index,
    stepId: a.step.id,
  })

  const values: Record<string, unknown> = {}
  for (const [name, decl] of Object.entries(fieldsOf(a.step))) {
    const field = obj(decl) as InputDef
    values[name] = field.default === undefined ? null : evalDeep(field.default, contexts)
  }
  return values
}
