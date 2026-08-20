/**
 * The `form` step adapter (03): the built-in schema-driven form, used mid-run.
 *
 * A form step has no `outputs` map — **the field values are the outputs**,
 * typed by their own definitions (02/03) — so this module is exactly two
 * functions: the initial values the form UI opens with (defaults may be
 * expressions, which is how an upstream output becomes an editable field), and
 * the validation + `step.succeeded` event a submit produces.
 *
 * Unlike the pipeline adapter there is nothing asynchronous here and no
 * effects: the caller emits the returned event. Rejected input comes back as
 * per-field messages, never as a throw.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import type { InputDef } from '@bffless/workflow-lint/definition'
import { buildContexts, evalDeep } from '../contexts'
import { validateValue } from '../outputs'
import { evalAnnotations, evalSummary } from '../results'
import type { Definition, RunEvent, RunState, Step, StepKey } from '../types'

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** `with.fields` — the field definitions, which double as the output types. */
function fieldsOf(step: Step): Record<string, InputDef> {
  return obj(obj(obj(step.raw).with).fields) as Record<string, InputDef>
}

function typeOf(field: InputDef): string {
  return typeof field.type === 'string' ? field.type : 'string'
}

/** "Unanswered" for the purposes of `required` — `false` and `0` are answers. */
function blank(value: unknown, list: boolean): boolean {
  if (value === null || value === undefined || value === '') return true
  return list && Array.isArray(value) && value.length === 0
}

function article(type: string, list: boolean): string {
  return list ? `a list of ${type} values` : `a ${type} value`
}

export interface FormStepArgs {
  step: Step
  key: StepKey
  job: string
  index: number
  def: Definition
  state: RunState
  values: Record<string, unknown>
}

export type FormResult =
  | { ok: true; event: Extract<RunEvent, { type: 'step.succeeded' }> }
  | { ok: false; errors: Record<string, string> }

/** Validate submitted field values against the form's field defs; evaluate summary/annotations. */
export function completeFormStep(a: FormStepArgs): FormResult {
  const errors: Record<string, string> = {}
  const outputs: Record<string, unknown> = {}

  for (const [name, decl] of Object.entries(fieldsOf(a.step))) {
    const field = obj(decl) as InputDef
    const type = typeOf(field)
    const list = field.list === true
    // Anything not submitted is unanswered, not undefined: outputs are JSON.
    const value = a.values[name] === undefined ? null : a.values[name]

    if (field.required === true && blank(value, list)) {
      errors[name] = 'This field is required'
      continue
    }
    if (!validateValue(type, list, value)) {
      errors[name] = `Expected ${article(type, list)}`
      continue
    }
    // Keys the form does not declare are dropped: the outputs are the fields.
    outputs[name] = value
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const contexts = buildContexts(a.def, a.state, {
    job: a.job,
    index: a.index,
    stepId: a.step.id,
    selfOutputs: outputs,
  })

  return {
    ok: true,
    event: {
      type: 'step.succeeded',
      key: a.key,
      outputs,
      summary: evalSummary(a.step, contexts),
      annotations: evalAnnotations(a.step, contexts),
      at: Date.now(),
    },
  }
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
