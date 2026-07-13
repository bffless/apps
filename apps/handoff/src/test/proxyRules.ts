/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Loads Handoff's BFFless backend for the rule tests.
 *
 * Handoff's `/api/*` (and `/feed/*`, `/r/*`) endpoints are authored as files under
 * `apps/handoff/.bffless/proxy-rules/<set>/` and compiled to the export JSON that CI
 * syncs to BFFless. The rule tests run the *real* embedded handlers, so they need that
 * compiled shape — this compiles it with `buildRuleSet`, the same compiler `bffless
 * rules push` uses, rather than re-deriving it. A hand-rolled reader could drift from
 * what actually ships; calling the compiler cannot.
 *
 * Handoff spans two rule sets — `handoff` (the app backend) and `handoff-rss-feed`
 * (the public folder feeds) — both attached to the same alias. `rules` merges them, so
 * a caller looks up an endpoint by path without caring which set carries it.
 */
import { fileURLToPath } from 'node:url'
import { buildRuleSet } from 'bffless/lib'

export type ProxyRule = Record<string, any> & {
  pathPattern: string
  method?: string
  methods?: string[]
}

export interface ProxySchema {
  id: string
  name: string
  fields: Array<Record<string, any>>
}

const SET_NAMES = ['handoff', 'handoff-rss-feed'] as const

const setDir = (name: string) =>
  fileURLToPath(new URL(`../../.bffless/proxy-rules/${name}/`, import.meta.url))

let cached: Promise<{ rules: ProxyRule[]; schemas: ProxySchema[] }> | undefined

/** Compile both Handoff rule sets and return their merged rules + schemas. Memoised per worker. */
export function loadProxyRules(): Promise<{ rules: ProxyRule[]; schemas: ProxySchema[] }> {
  cached ??= (async () => {
    const built = await Promise.all(SET_NAMES.map((name) => buildRuleSet(setDir(name))))
    return {
      rules: built.flatMap((b) => b.export.rules as ProxyRule[]),
      schemas: built.flatMap((b) => (b.export.schemas ?? []) as ProxySchema[]),
    }
  })()
  return cached
}

/** Find a rule by path, and (when given) by the method it serves — `any` rules match via `methods`. */
export function findRule(rules: ProxyRule[], pathPattern: string, method?: string): ProxyRule {
  const rule = rules.find(
    (r) =>
      r.pathPattern === pathPattern &&
      (method === undefined || r.method === method || (r.methods ?? []).includes(method)),
  )
  if (!rule) throw new Error(`no rule for ${method ?? 'ANY'} ${pathPattern}`)
  return rule
}

/**
 * Compile embedded handler source into a callable — the same JS CE executes.
 *
 * This mirrors the runtime's contract (`function-runner.service.ts`, and the `bffless/harness`
 * runner): evaluate the source as statements, then pick up the resulting top-level `handler`.
 * It deliberately does NOT do `return (<code>)`, which only works when the source happens to be a
 * bare function expression. A `.fn.ts` handler compiles to an esbuild IIFE followed by
 * `var handler = __bfflessHandler.default || __bfflessHandler.handler`, and wrapping THAT in
 * `return (...)` is a syntax error. Evaluating-then-reading `handler` handles both forms.
 */
export function compileHandler(code: string): (ctx: any) => any {
  const fn = new Function(`${code}\n;return typeof handler === 'function' ? handler : undefined;`)()
  if (typeof fn !== 'function') {
    throw new Error('handler source did not define a top-level `handler` function')
  }
  return fn as (ctx: any) => any
}

/** Compile a pipeline step's embedded handler into a callable. */
export function handlerOf(rule: ProxyRule, stepId: string): (ctx: any) => any {
  const step = rule.pipelineConfig?.steps?.find((s: any) => s.id === stepId)
  if (!step) throw new Error(`no step "${stepId}" on ${rule.method ?? 'ANY'} ${rule.pathPattern}`)
  return compileHandler(step.config.code)
}
