/**
 * Starting a run from the URL alone (07/D12): `?auto=1&inputs=<base64url(JSON)>`
 * is how the headless driver kicks a run off, with no Start click and nobody
 * to read an error message.
 *
 * The validation loop lives here rather than in `KickoffForm` because both
 * paths must be the same loop: a driver whose inputs the auto path accepted
 * and the form would have refused (or the other way round) would make the
 * harness's own "headless and interactive are the same code" claim false. The
 * form still owns everything about *editing* — blanks-while-typing, upload
 * bookkeeping, per-field errors as you go — this owns only the answer to "are
 * these values startable?".
 *
 * `file` inputs arrive as **already-stored paths**: the driver uploads through
 * `/api/workflow/files/prepare|register` (06) before it opens the page, so
 * nothing here fetches anything. `https://` values are deliberately not
 * supported (07's own note, deferred): the page never fetches a URL a caller
 * handed it.
 */
import type { InputDef } from '@bffless/workflow-lint/definition'
import { validateInputConstraints } from './runner/inputConstraints'
import { validateValue } from './runner/outputs'

export type DecodedInputs =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * base64url → the raw JSON text. Padding is optional (a driver that trims `=`
 * and one that keeps it must both work), and the bytes are read as UTF-8, so
 * a `greeting` with an accent in it survives the round trip.
 */
function decodeBase64Url(param: string): string {
  const standard = param.replace(/-/g, '+').replace(/_/g, '/')
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/**
 * The `inputs` query parameter, read. Every way it can be wrong comes back as
 * an `error` string rather than a throw: this runs inside a React effect on a
 * page whose whole job is to *report* a refused start, and an exception there
 * would blank the page instead — leaving a driver watching a screen that
 * never says why.
 *
 * A missing parameter is an error too, not "no inputs": a workflow that takes
 * none is started with `inputs=e30` (`{}`), so an absent parameter is a driver
 * bug, and guessing `{}` for it would silently run a workflow on its defaults.
 */
export function decodeInputs(param: string | null | undefined): DecodedInputs {
  if (param === null || param === undefined || param === '') {
    return { ok: false, error: 'No `inputs` parameter — a run with no inputs is started with `inputs=e30`' }
  }

  let json: string
  try {
    json = decodeBase64Url(param)
  } catch {
    return { ok: false, error: '`inputs` is not valid base64url' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: '`inputs` does not decode to valid JSON' }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '`inputs` must decode to a JSON object of input values' }
  }
  return { ok: true, values: parsed as Record<string, unknown> }
}

/** "Unanswered" for `required` — `false` and `0` are answers (03's own rule). */
export function blank(value: unknown, list: boolean): boolean {
  if (value === null || value === undefined || value === '') return true
  return list && Array.isArray(value) && value.length === 0
}

function typeOf(def: InputDef): string {
  return typeof def.type === 'string' ? def.type : 'string'
}

/**
 * Every declared input, resolved to a starting value: what the caller supplied
 * if it supplied one, otherwise the declaration's `default`, otherwise `null`.
 *
 * Shared by the form (its initial state, and its Re-run prefill) and the auto
 * path (the driver's `?inputs=`) for the same reason the validation loop is:
 * the two must agree on what an omitted input means. Keyed off the
 * *declarations*, so a value for an input the workflow does not declare is
 * dropped rather than smuggled into the run's `inputs`.
 */
export function initialValues(
  inputs: Record<string, InputDef>,
  supplied: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(inputs)) {
    if (supplied && name in supplied) values[name] = supplied[name]
    else values[name] = def.default === undefined ? null : def.default
  }
  return values
}

/**
 * Are these values startable? One message per bad input, keyed by input name —
 * `{}` means yes. Every field is checked, not just the first, so a driver gets
 * the whole list back in one go exactly as a person does.
 */
export function validateInputs(
  inputs: Record<string, InputDef>,
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const [name, def] of Object.entries(inputs)) {
    const type = typeOf(def)
    const list = def.list === true
    const value = values[name] ?? null
    if (def.required === true && blank(value, list)) {
      errors[name] = 'This field is required'
      continue
    }
    if (!validateValue(type, list, value)) {
      errors[name] = `Expected a valid ${type} value`
      continue
    }
    const constraintError = validateInputConstraints(def, value)
    if (constraintError) errors[name] = constraintError
  }
  return errors
}
