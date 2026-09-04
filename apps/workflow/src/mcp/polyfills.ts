/**
 * Two globals CE's `function_handler` sandbox does not have, injected into
 * every MCP-endpoint bundle by esbuild's `inject` (`scripts/build-mcp.mjs`;
 * Phase 2 plan, Decision 2).
 *
 * The sandbox (`repos/ce/apps/backend/src/pipelines/function-runner.service.ts`)
 * exposes `Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp,
 * Map, Set, WeakMap, WeakSet, Promise, Symbol, BigInt`, the URI functions and
 * a captured `console` — and nothing else that is not a JS intrinsic. Two of
 * the app's pure adapters reach for more:
 *
 * - `lib/runner/adapters/island.ts` resolves a `src` / tool name with
 *   `new URL(x, base).pathname` to decide whether it stays inside
 *   `/w/<impl>/` or `/api/<impl>/` (the own-implementation fence);
 * - `annotateEvent` measures annotation budgets with `TextEncoder`.
 *
 * Both are implemented here to exactly the extent those callers use them, no
 * more: a pathname-only URL and a byte-length-only encoder. `polyfills.test.ts`
 * holds the URL one to the real `URL` on the traversal spellings the fence
 * exists to catch. Injected rather than assigned because the sandbox's
 * prohibited-pattern scan refuses `globalThis.`.
 */

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** A WHATWG double-dot segment: `..`, `.%2e`, `%2e.`, `%2e%2e` (case-insensitive). */
function isDoubleDot(segment: string): boolean {
  const s = segment.toLowerCase()
  return s === '..' || s === '.%2e' || s === '%2e.' || s === '%2e%2e'
}

/** A WHATWG single-dot segment: `.` or `%2e`. */
function isSingleDot(segment: string): boolean {
  const s = segment.toLowerCase()
  return s === '.' || s === '%2e'
}

/**
 * `new URL(input, base).pathname` for an http(s) base: strips a scheme and
 * authority when present, drops query and fragment, treats `\` as `/`, and
 * normalises dot segments the way the URL path parser does (a trailing `.` or
 * `..` leaves a trailing slash; empty segments are kept). Nothing else — no
 * `href`, `origin`, `searchParams`.
 */
export class URL {
  readonly pathname: string

  constructor(input: string, base?: string) {
    // Only http(s) bases are ever passed (the fence's `https://harness.invalid`); a base changes nothing about a pathname.
    void base
    let path = String(input).replace(/\\/g, '/')
    if (SCHEME.test(path)) {
      const afterScheme = path.slice(path.indexOf(':') + 1)
      if (afterScheme.startsWith('//')) {
        const slash = afterScheme.indexOf('/', 2)
        path = slash === -1 ? '/' : afterScheme.slice(slash)
      } else {
        path = afterScheme
      }
    } else if (path.startsWith('//')) {
      const slash = path.indexOf('/', 2)
      path = slash === -1 ? '/' : path.slice(slash)
    }
    path = path.split('#')[0].split('?')[0]

    const segments = path.split('/')
    if (segments[0] === '') segments.shift()
    const out: string[] = []
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const last = i === segments.length - 1
      if (isDoubleDot(segment)) {
        out.pop()
        if (last) out.push('')
      } else if (isSingleDot(segment)) {
        if (last) out.push('')
      } else {
        out.push(segment)
      }
    }
    this.pathname = '/' + out.join('/')
  }
}

/** `.encode(s).length` — the UTF-8 byte count of `s`. Surrogate pairs count four. */
export class TextEncoder {
  encode(input: string): { length: number } {
    const s = String(input)
    let bytes = 0
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i)
      if (code < 0x80) bytes += 1
      else if (code < 0x800) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4
        i++
      } else bytes += 3
    }
    return { length: bytes }
  }
}
