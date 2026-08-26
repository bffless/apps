import { countFindings, sortFindings, type Counts, type Finding } from './findings.js'
import { loadYaml } from './yaml/load.js'
import { validateDefinition } from './schema/validate.js'
import { toDefinition, type Definition } from './model/definition.js'
import { collectSites } from './model/slots.js'
import { runChecks } from './checks/index.js'
import type { RuleSetContext } from './rules/match.js'

export type { Finding, Severity, Counts } from './findings.js'

export interface LintResult {
  file?: string
  findings: Finding[]
  counts: Counts
}

const FLOW_EXPR_HINT =
  'Inside a flow mapping/sequence ({ … } / [ … ]) an expression must be quoted — ' +
  'because ${{ opens a nested mapping. Block style needs no quotes.'

export interface LintOptions {
  file?: string
  /**
   * The implementation's proxy-rule set, when the caller can see the repo
   * (`resolveRuleSet`, CLI/CI). Omitted in the browser harness — the
   * `rule-missing` check then stays silent (06).
   */
  rules?: RuleSetContext
}

export function lintSource(source: string, opts: LintOptions = {}): LintResult {
  const done = (findings: Finding[]): LintResult => ({
    file: opts.file,
    findings: sortFindings(findings),
    counts: countFindings(findings),
  })

  const { data, findings: yamlFindings, locate } = loadYaml(source)
  if (yamlFindings.length > 0) return done(yamlFindings)

  const schemaFindings = validateDefinition(data)
  const located = (f: Finding): Finding => ({ ...f, pos: f.pos ?? locate(f.path) })
  if (schemaFindings.length > 0) {
    // Static checks assume a schema-valid shape; stop here.
    return done(schemaFindings.map(located))
  }

  const def = toDefinition(data)
  const sites = collectSites(def)

  const findings: Finding[] = []
  for (const site of sites) {
    if (site.parseError) {
      findings.push({
        rule: 'expr-parse',
        severity: 'error',
        message: `invalid expression \`${site.raw.trim()}\` — ${site.parseError.message}`,
        path: site.pointer,
        hint: site.raw.includes('${{') || site.parseError.message.includes('unclosed') ? FLOW_EXPR_HINT : undefined,
      })
    }
  }
  findings.push(...runChecks(def, sites, opts.rules))

  return done(findings.map(located))
}

export interface LoadResult {
  def: Definition | null
  findings: Finding[]
  counts: Counts
}

/** lintSource + the typed Definition when the document is structurally valid (M1 harness entry). */
export function loadDefinition(source: string, opts: LintOptions = {}): LoadResult {
  const res = lintSource(source, opts)
  const fatal = res.findings.some((f) => f.rule === 'yaml-parse' || f.rule === 'schema')
  const def = fatal ? null : toDefinition(loadYaml(source).data)
  return { def, findings: res.findings, counts: res.counts }
}
