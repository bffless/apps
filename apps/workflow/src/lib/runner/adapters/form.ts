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
 * A field's `options` may itself be an expression (03) — "the four covers the
 * previous step drew" — so the fields the UI renders and the fields a submit
 * is checked against are the *evaluated* ones (`formFieldDefs`), never the raw
 * `with.fields`: a value is only in the allowed set if the user could have
 * been shown it.
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

// The one notion of "the allowed values" of an `options` list (02), re-exported
// here because a form's fields are where the harness reads one: the field
// renderer and this adapter must agree about what a File-ref option is worth.
export { optionValue, optionValues } from '../inputConstraints'

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
  // Evaluated, so `choice` membership is checked against the options the form
  // actually offered rather than the expression that produced them.
  const { outputs, errors } = validateDeclared(formFieldDefs(a), a.values, {
    defaultType: 'string',
  })

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return { ok: true, event: succeededEvent(a, outputs, a.at) }
}

/**
 * What the form is *shown with* — its `with` evaluated against the run so far
 * (title, description, fields with their `default`/`options` expressions
 * resolved, submit) — recorded as the step's `inputs` on `step.waiting`, so a
 * form step has the same provenance on its Input side as any other step
 * (`default: ${{ needs.slow.outputs.report }}` → "from slow job output").
 */
export function formInputs(a: {
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
  return obj(evalDeep(obj(a.step.raw?.with), contexts))
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

/**
 * The form's field definitions with any expression `options` evaluated (03):
 * `options: "${{ steps.draw.outputs.covers }}"` becomes the list of File refs
 * that step produced, which 02 reads as `{value: path, label: name, preview:
 * ref}` — a tile picker in the UI and a membership set at submit.
 *
 * An expression that does not evaluate to a list (or that cannot be evaluated
 * at all — an upstream step that never ran) leaves the field with **no**
 * options rather than with its unresolved expression: there is nothing honest
 * to offer, and `completeFormStep` then refuses every value for it, rather
 * than accepting one whose provenance the harness cannot explain.
 */
export function formFieldDefs(a: {
  step: Step
  def: Definition
  state: RunState
  job: string
  index: number
}): Record<string, InputDef> {
  const fields = fieldsOf(a.step)
  const names = Object.keys(fields)
  if (!names.some((name) => typeof obj(fields[name]).options === 'string')) return fields

  const contexts = buildContexts(a.def, a.state, {
    job: a.job,
    index: a.index,
    stepId: a.step.id,
  })

  const evaluated: Record<string, InputDef> = {}
  for (const name of names) {
    const field = obj(fields[name]) as InputDef
    if (typeof field.options !== 'string') {
      evaluated[name] = field
      continue
    }
    let options: unknown
    try {
      options = evalDeep(field.options, contexts)
    } catch {
      options = null
    }
    evaluated[name] = { ...field, options: Array.isArray(options) ? options : [] }
  }
  return evaluated
}
