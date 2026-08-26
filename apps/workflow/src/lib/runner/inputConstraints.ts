/**
 * Input-specific constraint keys (02): `validateValue` (`./outputs`) only
 * checks a value's *type shape* — the closed vocabulary — and deliberately
 * knows nothing about a definition's extra keys (`min`/`max`, `pattern`,
 * `minLength`/`maxLength`, `options`). Those keys are per-field constraints
 * on top of the type, so they live in their own pure function: the kickoff
 * form (08) and the (M2) mid-run form step both need them at submit time,
 * and neither is the type-vocabulary's concern.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint's
 * lib/runner fence) — plain data in, an error message or `undefined` out.
 */
import type { InputDef } from '@bffless/workflow-lint/definition'

/**
 * One `options` entry (02) → the value it stands for, or `undefined` when the
 * entry cannot be read: a bare string is its own value, `{value, label}` says
 * so, and a **File ref is the 02 shorthand** for `{value: path, label: name,
 * preview: ref}` — so a File-ref option's value is its `path`.
 *
 * This is the single notion of "what this option is worth", shared by the
 * membership check below, the `form` adapter (`adapters/form.ts`, which
 * re-exports `optionValues`) and the field renderer (`FieldControl`), so a
 * tile the user can click can never be a value the submit then refuses.
 */
export function optionValue(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (entry === null || typeof entry !== 'object') return undefined
  const o = entry as Record<string, unknown>
  if (typeof o.value === 'string') return o.value
  if (typeof o.path === 'string' && typeof o.name === 'string' && typeof o.url === 'string') return o.path
  return undefined
}

/** Every readable option's value; a non-array (an unevaluated expression) has none. */
export function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  return options.map(optionValue).filter((value): value is string => value !== undefined)
}

/** `options: [a, {value, label}, <File ref>]` (02) flattened to the allowed value strings. */
function allowedChoices(options: unknown): string[] | null {
  if (!Array.isArray(options)) return null
  const allowed = optionValues(options)
  // An option this module cannot read (an unresolved expression, or a
  // malformed entry) means membership cannot be checked honestly — bail out
  // entirely rather than rejecting values that may well be valid. An options
  // list that is *empty* is readable, and means no value is allowed.
  return allowed.length === options.length ? allowed : null
}

/** A compiled `pattern`; an invalid regex cannot honestly fail a value, so it is skipped. */
function safePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

/** One already-type-checked scalar against its definition's extra keys (02). */
function scalarConstraintError(def: InputDef, value: unknown): string | undefined {
  const type = typeof def.type === 'string' ? def.type : 'string'

  if (type === 'number' && typeof value === 'number') {
    if (typeof def.min === 'number' && value < def.min) return `Must be at least ${def.min}`
    if (typeof def.max === 'number' && value > def.max) return `Must be at most ${def.max}`
    return undefined
  }

  if (type === 'string' && typeof value === 'string') {
    if (typeof def.minLength === 'number' && value.length < def.minLength) {
      return `Must be at least ${def.minLength} characters`
    }
    if (typeof def.maxLength === 'number' && value.length > def.maxLength) {
      return `Must be at most ${def.maxLength} characters`
    }
    if (typeof def.pattern === 'string') {
      const re = safePattern(def.pattern)
      if (re && !re.test(value)) return 'Does not match the required format'
    }
    return undefined
  }

  if (type === 'choice' && typeof value === 'string') {
    const allowed = allowedChoices(def.options)
    if (allowed && !allowed.includes(value)) return 'Is not one of the allowed choices'
    return undefined
  }

  return undefined
}

/**
 * Validate an already type-checked field value against its definition's
 * input-specific keys — `null`/`undefined` (unanswered) and every item of a
 * `list: true` value that is itself type-valid. Call after `validateValue`
 * (`./outputs`), which owns the type-shape check this function assumes
 * already passed.
 */
export function validateInputConstraints(def: InputDef, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined

  if (def.list === true) {
    if (!Array.isArray(value)) return undefined // validateValue already rejects this shape
    for (const item of value) {
      const error = scalarConstraintError(def, item)
      if (error) return error
    }
    return undefined
  }

  return scalarConstraintError(def, value)
}
