/**
 * The `form` step adapter (03): the built-in schema-driven form, used mid-run.
 *
 * A form step has no `outputs` map — **the field values are the outputs**,
 * typed by their own definitions (02/03) — so this module is essentially two
 * things: the initial values the form UI opens with (defaults may be
 * expressions, which is how an upstream output becomes an editable field), and
 * the acceptance of a set of values (`validateFormOutputs`), which
 * `completeFormStep` wraps in the `step.succeeded` a submit produces and a
 * `headless: skip` reuses whole. Both halves of that second thing are the
 * declaration walk shared with the island adapter (`./declared`); a form's
 * declarations are its fields, untyped meaning `string` (02).
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
  const result = validateFormOutputs(formFieldDefs(a), a.values)
  if (!result.ok) return { ok: false, errors: result.errors }
  return { ok: true, event: succeededEvent(a, result.outputs, a.at) }
}

export type FormOutputs =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; errors: Record<string, string> }

/**
 * Field values → the step's outputs: the whole acceptance decision for a form,
 * with no event and no clock around it.
 *
 * Extracted from `completeFormStep` (Task 12) because a **headless skip** is
 * the same decision made without a person: `headless: { mode: skip, outputs: … }`
 * (07) declares values for a form step's fields, and they must be accepted or
 * refused on exactly the terms a submit would be — including the File-ref
 * round trip below, which the live `interactive.workflow.yaml` depends on
 * (its `cover` field is a `choice` over File refs and its skip value is one of
 * those refs). Two readings of "is this a valid answer to this form" would be
 * a run that a person can finish and CI cannot, or the reverse.
 */
export function validateFormOutputs(
  fields: Record<string, InputDef>,
  values: Record<string, unknown>,
): FormOutputs {
  const { outputs, errors } = validateDeclared(fields, withOptionPaths(fields, values), {
    defaultType: 'string',
  })

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return { ok: true, outputs: withFileRefs(fields, outputs) }
}

/** `path -> ref` for a `choice` whose options are File refs (02's shorthand); `undefined` for every other field. */
function fileRefOptions(field: InputDef): Map<string, unknown> | undefined {
  if (field.type !== 'choice' || !Array.isArray(field.options)) return undefined
  const refs = new Map<string, unknown>()
  for (const option of field.options) {
    if (isFileRefLike(option)) refs.set(option.path, option)
  }
  return refs.size === 0 ? undefined : refs
}

/**
 * The inverse of `withFileRefs`, applied *before* validation: a `choice` is
 * only ever a **string** to `validateValue` (`../outputs`) and membership is
 * checked against `optionValue(entry)` — a File-ref option's `path` — so a
 * value that arrives as the ref itself is normalised to the path it names.
 *
 * The UI's own submit already sends paths, so this changes nothing there. It
 * exists for the headless skip, whose declared value is written as an
 * expression over an upstream step's outputs (`${{ needs.card.outputs.posters[0] }}`)
 * and therefore evaluates to the ref object, not to its path.
 */
function withOptionPaths(
  fields: Record<string, InputDef>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...values }
  for (const [name, field] of Object.entries(fields)) {
    if (!fileRefOptions(field)) continue
    const value = normalized[name]
    if (isFileRefLike(value)) normalized[name] = value.path
    else if (Array.isArray(value)) {
      normalized[name] = value.map((v) => (isFileRefLike(v) ? v.path : v))
    }
  }
  return normalized
}

/**
 * A `choice` over File refs (02's shorthand) is *edited* by path — the tile's
 * value, what membership is checked against — but *recorded* as the ref the
 * path named, so everything downstream (`steps.confirm.outputs.cover`, a job
 * or run output declared `type: file`, the cards) keeps the file's name, size,
 * content type and url rather than a bare path (2026-08-26 review). A value
 * that matches no ref (a plain string option) is recorded as it was.
 */
function withFileRefs(
  fields: Record<string, InputDef>,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  const upgraded: Record<string, unknown> = { ...outputs }
  for (const [name, field] of Object.entries(fields)) {
    const refs = fileRefOptions(field)
    if (!refs) continue
    const value = outputs[name]
    if (typeof value === 'string') upgraded[name] = refs.get(value) ?? value
    else if (Array.isArray(value)) {
      upgraded[name] = value.map((v) => (typeof v === 'string' ? (refs.get(v) ?? v) : v))
    }
  }
  return upgraded
}

function isFileRefLike(value: unknown): value is { path: string; name: string; url: string } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.path === 'string' && typeof v.name === 'string' && typeof v.url === 'string'
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
