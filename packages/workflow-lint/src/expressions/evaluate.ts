import type { Expr } from './ast.js'
import { scanTemplates, isSingleExpression } from './template.js'
// Circular with functions.js (it uses interpolate/looseEq); safe: both sides
// only dereference the other at call time, never during module evaluation.
import { FUNCTIONS } from './functions.js'

export class EvalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvalError'
  }
}

export interface EvalOptions {
  /** inputs, needs, steps, matrix, response, error, step, run, impl, jobs, strategy … */
  contexts: Record<string, unknown>
  /** Status functions; absent outside `if` slots (calling one then throws). */
  status?: {
    success(): boolean
    failure(): boolean
    always(): boolean
    cancelled(): boolean
  }
}

/** GitHub truthiness: false, 0, NaN, '', null are falsy. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return false
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  return true
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') return v === '' ? 0 : Number(v)
  return NaN
}

/** GitHub loose equality: case-insensitive strings, numeric coercion across types. */
export function looseEq(a: unknown, b: unknown): boolean {
  const an = a ?? null
  const bn = b ?? null
  if (typeof an === 'string' && typeof bn === 'string') {
    return an.toLowerCase() === bn.toLowerCase()
  }
  if (an === null && bn === null) return true
  if (typeof an === typeof bn && typeof an !== 'object') return an === bn
  if (typeof an === 'object' && an !== null && typeof bn === 'object' && bn !== null) {
    return Object.is(an, bn)
  }
  const x = toNum(an)
  const y = toNum(bn)
  return !Number.isNaN(x) && !Number.isNaN(y) && x === y
}

/** Property/index access: any miss is null, never a throw (01). */
function access(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return null
  if (Array.isArray(obj)) {
    const i = typeof key === 'number' ? key : Number(key)
    if (!Number.isInteger(i) || i < 0 || i >= obj.length) return null
    return obj[i] ?? null
  }
  if (typeof obj === 'object') {
    const v = (obj as Record<string, unknown>)[String(key)]
    return v === undefined ? null : v
  }
  return null
}

/** Interpolation stringification: null→'', scalars via String, arrays/objects as JSON. */
export function interpolate(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function evaluate(expr: Expr, opts: EvalOptions): unknown {
  switch (expr.kind) {
    case 'null':
      return null
    case 'true':
      return true
    case 'false':
      return false
    case 'number':
      return expr.value
    case 'string':
      return expr.value
    case 'ident': {
      const v = opts.contexts[expr.name]
      return v === undefined ? null : v
    }
    case 'member':
      return access(evaluate(expr.object, opts), expr.property)
    case 'index':
      return access(evaluate(expr.object, opts), evaluate(expr.index, opts))
    case 'not':
      return !truthy(evaluate(expr.operand, opts))
    case 'binary': {
      const { op } = expr
      if (op === '&&') {
        const l = evaluate(expr.left, opts)
        return truthy(l) ? evaluate(expr.right, opts) : l
      }
      if (op === '||') {
        const l = evaluate(expr.left, opts)
        return truthy(l) ? l : evaluate(expr.right, opts)
      }
      const l = evaluate(expr.left, opts)
      const r = evaluate(expr.right, opts)
      if (op === '==') return looseEq(l, r)
      if (op === '!=') return !looseEq(l, r)
      const x = toNum(l)
      const y = toNum(r)
      if (Number.isNaN(x) || Number.isNaN(y)) return false
      if (op === '<') return x < y
      if (op === '<=') return x <= y
      if (op === '>') return x > y
      return x >= y
    }
    case 'call': {
      const name = expr.callee.toLowerCase()
      if (name === 'success' || name === 'failure' || name === 'always' || name === 'cancelled') {
        if (!opts.status) throw new EvalError(`${expr.callee}() is only valid in if`)
        return opts.status[name]()
      }
      const fn = FUNCTIONS[name]
      if (!fn) throw new EvalError(`unknown function ${expr.callee}()`)
      return fn(...expr.args.map((a) => evaluate(a, opts)))
    }
  }
}

/**
 * Evaluate a YAML scalar: exactly one expression keeps its type, anything else
 * is string interpolation (01).
 */
export function renderTemplate(value: string, opts: EvalOptions): unknown {
  const spans = scanTemplates(value)
  if (spans.length === 0) return value
  for (const s of spans) {
    if (s.error) throw new EvalError(s.error.message)
  }
  if (isSingleExpression(value)) return evaluate(spans[0]!.expr!, opts)
  let out = ''
  let i = 0
  for (const s of spans) {
    out += value.slice(i, s.start - 3)
    out += interpolate(evaluate(s.expr!, opts))
    i = s.end + 2
  }
  out += value.slice(i)
  return out
}
