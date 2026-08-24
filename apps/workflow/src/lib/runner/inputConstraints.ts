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

/** `options: [a, {value, label}]` (02) flattened to the allowed value strings. */
function allowedChoices(options: unknown): string[] | null {
  if (!Array.isArray(options)) return null
  const allowed: string[] = []
  for (const entry of options) {
    if (typeof entry === 'string') {
      allowed.push(entry)
      continue
    }
    if (entry !== null && typeof entry === 'object') {
      const value = (entry as Record<string, unknown>).value
      if (typeof value === 'string') {
        allowed.push(value)
        continue
      }
    }
    // An option this module cannot read (an unresolved expression, or a
    // malformed entry) means membership cannot be checked honestly — bail
    // out entirely rather than rejecting values that may well be valid.
    return null
  }
  return allowed
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
