import { EvalError, interpolate, looseEq } from './evaluate.js'

export const STATUS_FUNCTIONS = ['success', 'failure', 'always', 'cancelled'] as const

/** The closed function set of 01-workflow-yaml.md (plus the two deviations). */
export const KNOWN_FUNCTIONS = [
  'contains',
  'startswith',
  'endswith',
  'format',
  'join',
  'tojson',
  'fromjson',
  'length',
  'pluck',
  ...STATUS_FUNCTIONS,
] as const

function str(v: unknown): string {
  return interpolate(v)
}

function pluckValue(list: unknown, key: string): unknown {
  if (!Array.isArray(list)) return null
  return list.map((el) => {
    if (Array.isArray(el)) return pluckValue(el, key)
    if (el !== null && typeof el === 'object') {
      const v = (el as Record<string, unknown>)[key]
      return v === undefined ? null : v
    }
    return null
  })
}

/** Non-status functions, keyed by lowercase name. */
export const FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  contains(hay, needle) {
    if (Array.isArray(hay)) return hay.some((el) => looseEq(el, needle))
    return str(hay).toLowerCase().includes(str(needle).toLowerCase())
  },
  startswith(s, prefix) {
    return str(s).toLowerCase().startsWith(str(prefix).toLowerCase())
  },
  endswith(s, suffix) {
    return str(s).toLowerCase().endsWith(str(suffix).toLowerCase())
  },
  format(fmt, ...args) {
    const template = str(fmt)
    let out = ''
    let i = 0
    while (i < template.length) {
      const c = template[i]!
      if (c === '{' && template[i + 1] === '{') {
        out += '{'
        i += 2
      } else if (c === '}' && template[i + 1] === '}') {
        out += '}'
        i += 2
      } else if (c === '{') {
        const close = template.indexOf('}', i)
        if (close === -1) throw new EvalError(`format: unmatched '{' in '${template}'`)
        const idx = Number(template.slice(i + 1, close))
        if (!Number.isInteger(idx) || idx < 0 || idx >= args.length) {
          throw new EvalError(`format: no argument {${template.slice(i + 1, close)}}`)
        }
        out += str(args[idx])
        i = close + 1
      } else {
        out += c
        i++
      }
    }
    return out
  },
  join(arr, sep) {
    if (!Array.isArray(arr)) return str(arr)
    return arr.map(str).join(sep === undefined ? ',' : str(sep))
  },
  tojson(v) {
    return JSON.stringify(v ?? null, null, 2)
  },
  fromjson(s) {
    try {
      return JSON.parse(str(s)) as unknown
    } catch (err) {
      throw new EvalError(`fromJSON: ${(err as Error).message}`)
    }
  },
  length(v) {
    if (typeof v === 'string' || Array.isArray(v)) return v.length
    return 0
  },
  pluck(list, key) {
    return pluckValue(list, str(key))
  },
}
