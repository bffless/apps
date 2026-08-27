/**
 * Reads an implementation's proxy-rule set off disk into the `RuleSetIndex`
 * the `rule-missing` check matches against (06).
 *
 * The layout and the derivation are the `bffless` CLI's, mirrored (not
 * imported — the CLI is not a dependency of this package): a rule is
 * `<stem>.rule.yaml` or `<stem>/rule.yaml` for one of the method stems, its
 * path pattern comes from the directory segments under `rules/`
 * (`[...x]`/`[x]` → `*`), and `pathPattern:` / `method:` / `methods:` in the
 * manifest override the derived values. A drift here can only cost the check
 * its accuracy — never the publish, which the CLI still compiles for real.
 *
 * This is the fs half of the feature; keep `./match.ts` free of `node:fs` so
 * the browser harness can import the lint entry (09).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { RuleEntry, RuleSetContext, RuleSetIndex } from './match.js'

export type { RuleEntry, RuleSetContext, RuleSetIndex, RuleSetUnresolved } from './match.js'

/** The CLI's `METHOD_STEMS` (`format/routes.ts`). */
const METHOD_STEMS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'any'])
const RULE_FILE_RE = new RegExp(`^(${[...METHOD_STEMS].join('|')})\\.rule\\.yaml$`)

function readYaml(file: string): Record<string, unknown> {
  const data: unknown = parse(readFileSync(file, 'utf8'))
  return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
}

/** `['api', 'hello', '[...path]']` → `/api/hello/*` (the CLI's `relPathToPattern`). */
function segmentsToPattern(segments: string[]): string {
  return '/' + segments.map((s) => (s.startsWith('[') && s.endsWith(']') ? '*' : s)).join('/')
}

function methodsOf(stem: string, manifest: Record<string, unknown>): string[] | undefined {
  if (stem !== 'any') return [stem.toUpperCase()]
  const list = manifest.methods
  if (Array.isArray(list) && list.length > 0) return list.map((m) => String(m).toUpperCase())
  if (typeof manifest.method === 'string') return [manifest.method.toUpperCase()]
  return undefined
}

function collect(dir: string, segments: string[], setDir: string, out: RuleEntry[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isFile()) {
      const stem = RULE_FILE_RE.exec(entry.name)?.[1]
      if (stem) push(full, stem, segments, setDir, out)
      continue
    }
    if (!entry.isDirectory()) continue
    const ruleYaml = join(full, 'rule.yaml')
    if (METHOD_STEMS.has(entry.name) && existsSync(ruleYaml)) push(ruleYaml, entry.name, segments, setDir, out)
    else collect(full, [...segments, entry.name], setDir, out)
  }
}

function push(manifestPath: string, stem: string, segments: string[], setDir: string, out: RuleEntry[]): void {
  const manifest = readYaml(manifestPath)
  if (manifest.isEnabled === false) return
  const pattern =
    typeof manifest.pathPattern === 'string' ? manifest.pathPattern : segmentsToPattern(segments)
  out.push({
    pattern,
    methods: methodsOf(stem, manifest),
    source: manifestPath.slice(setDir.length + 1),
  })
}

/**
 * Index the rule set at `dir`. `alias` defaults to the set's `name:` — the
 * name it syncs under, which is also the alias it is attached to (06).
 */
export function scanRuleSet(dir: string, opts: { alias?: string } = {}): RuleSetIndex {
  const setDir = resolve(dir)
  const manifest = existsSync(join(setDir, 'ruleset.yaml')) ? readYaml(join(setDir, 'ruleset.yaml')) : {}
  const alias = opts.alias ?? (typeof manifest.name === 'string' ? manifest.name : basename(setDir))
  const rules: RuleEntry[] = []
  collect(join(setDir, 'rules'), [], setDir, rules)
  // The prefix is read off the set, so the check follows the layout rather than
  // dictating it: hand-prefixed today, bare `/api` once publish-workflow adds
  // the prefix at sync time (06).
  const prefix = existsSync(join(setDir, 'rules', 'api', alias)) ? `/api/${alias}` : '/api'
  return { found: true, alias, dir: setDir, prefix, rules }
}

export interface ResolveOptions {
  /** The workflow file being linted; its ancestors are searched for `.bffless/proxy-rules`. */
  file?: string
  /** `--rules`: an explicit rule-set directory, skipping the search. */
  rulesDir?: string
  /** `--alias`: picks one set when several are found, and names the deployed alias. */
  alias?: string
}

/** The nearest `.bffless/proxy-rules` at or above `from`. */
function findProxyRulesDir(from: string): string | undefined {
  let dir = resolve(from)
  for (;;) {
    const candidate = join(dir, '.bffless', 'proxy-rules')
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Resolve the rule set a workflow's relative paths should be checked against.
 * Never throws: anything unresolvable comes back as `{ found: false, reason }`
 * so the check can downgrade to a notice and the lint still runs.
 */
export function resolveRuleSet(opts: ResolveOptions): RuleSetContext {
  try {
    if (opts.rulesDir) {
      const dir = resolve(opts.rulesDir)
      if (!existsSync(dir)) return { found: false, reason: `no such rule-set directory: ${opts.rulesDir}` }
      return scanRuleSet(dir, { alias: opts.alias })
    }

    if (!opts.file) return { found: false, reason: 'no file to search from; pass --rules <dir>' }
    const proxyRules = findProxyRulesDir(dirname(resolve(opts.file)))
    if (!proxyRules) {
      return { found: false, reason: `no .bffless/proxy-rules directory above ${opts.file}` }
    }

    const sets = readdirSync(proxyRules, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(proxyRules, e.name, 'ruleset.yaml')))
      .map((e) => e.name)
      .sort()

    if (sets.length === 0) return { found: false, reason: `no rule set in ${proxyRules}` }
    if (opts.alias) {
      if (!sets.includes(opts.alias)) {
        return { found: false, reason: `no \`${opts.alias}\` rule set in ${proxyRules} (found ${sets.join(', ')})` }
      }
      return scanRuleSet(join(proxyRules, opts.alias), { alias: opts.alias })
    }
    const only = sets[0]
    if (sets.length > 1 || only === undefined) {
      return { found: false, reason: `several rule sets in ${proxyRules} (${sets.join(', ')}) — pass --alias` }
    }
    return scanRuleSet(join(proxyRules, only))
  } catch (err) {
    return { found: false, reason: (err as Error).message }
  }
}
