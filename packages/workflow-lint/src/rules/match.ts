/**
 * The rule-set index a workflow's relative paths are checked against, and the
 * pure matching over it (06 *Implementation CI obligations*, 01 *Paths*).
 *
 * A `pipeline` step names its endpoint relative to the implementation
 * (`with: { path: echo }` → `POST /api/<alias>/echo`, 01) while the endpoint
 * itself is a directory in the implementation's rule set
 * (`rules/api/<alias>/echo/post/rule.yaml`). Nothing links the two, so a typo
 * on either side is a 404 at run time. This module is the link: an index built
 * from the rule set on disk (`./scan.ts`, the only fs-touching half) plus the
 * matcher `checks/rules.ts` runs against it.
 *
 * Deliberately pure — no `node:fs` — so the browser harness can import the
 * lint entry without pulling the filesystem in (09 purity fence).
 */

/** One rule in a scanned set, as the server would see it. */
export interface RuleEntry {
  /** CE `pathPattern`, e.g. `/api/hello/echo` or `/w/hello/*`. */
  pattern: string
  /** Uppercased methods the rule answers; `undefined` = every method (an `any` rule). */
  methods?: string[]
  /** Manifest path relative to the rule-set directory, for messages. */
  source: string
}

export interface RuleSetIndex {
  found: true
  /** The alias the implementation deploys to — the rule set's `name:`, or `--alias`. */
  alias: string
  /** Absolute path of the rule-set directory (`…/.bffless/proxy-rules/<name>`). */
  dir: string
  /**
   * The URL prefix a relative `with.path` resolves against — what the *server*
   * will see. Read off the set (`/api/<alias>` while implementations author the
   * prefix by hand, `/api` otherwise), or handed in as `--path-prefix`, which
   * is what the publisher applies at sync time (06).
   */
  prefix: string
  /**
   * The same prefix as it appears *on disk*, under `rules/`. The two differ
   * exactly when `--path-prefix` is in play: the publisher adds those segments
   * at sync time, so the author never types them and the directory a missing
   * rule should be added at carries no prefix at all (`''`).
   */
  layout: string
  rules: RuleEntry[]
}

/** No set could be resolved — the check downgrades to a notice, never an error. */
export interface RuleSetUnresolved {
  found: false
  reason: string
}

export type RuleSetContext = RuleSetIndex | RuleSetUnresolved

/**
 * CE's glob semantics, verbatim (`proxy.middleware.ts` `matchesPattern`):
 * an exact match, or `*` → `.*` over the whole pattern (so a `*` crosses `/`).
 */
export function patternMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true
  if (!pattern.includes('*')) return false
  const source = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  return new RegExp(source).test(path)
}

/** The first rule that would serve `method url`, in the set's own order. */
export function findRule(index: RuleSetIndex, url: string, method: string): RuleEntry | undefined {
  return index.rules.find(
    (r) => patternMatches(r.pattern, url) && (r.methods === undefined || r.methods.includes(method.toUpperCase())),
  )
}

/** The absolute URL a relative `with.path` / `poll.path` resolves to (01). */
export function resolveUrl(index: RuleSetIndex, path: string): string {
  return `${index.prefix}/${path.replace(/^\/+/, '')}`
}

/** The manifest a missing rule should be authored as, relative to the set directory. */
export function expectedRuleFile(index: RuleSetIndex, path: string, method: string): string {
  const segments = [
    ...index.layout.split('/').filter(Boolean),
    ...path.split('/').filter(Boolean),
    method.toLowerCase(),
  ]
  return `rules/${segments.join('/')}/rule.yaml`
}
