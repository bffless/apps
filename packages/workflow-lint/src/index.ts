import { readFileSync } from 'node:fs'
import { countFindings, sortFindings, type Counts, type Finding } from './findings.js'
import { loadYaml } from './yaml/load.js'
import { validateDefinition } from './schema/validate.js'
import { toDefinition } from './model/definition.js'
import { collectSites } from './model/slots.js'
import { runChecks } from './checks/index.js'

export type { Finding, Severity, Counts } from './findings.js'
export { toDefinition, type Definition, type Job, type Step } from './model/definition.js'

export interface LintResult {
  file?: string
  findings: Finding[]
  counts: Counts
}

const FLOW_EXPR_HINT =
  'Inside a flow mapping/sequence ({ … } / [ … ]) an expression must be quoted — ' +
  'because ${{ opens a nested mapping. Block style needs no quotes.'

export function lintSource(source: string, opts: { file?: string } = {}): LintResult {
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
  findings.push(...runChecks(def, sites))

  return done(findings.map(located))
}

export function lintFile(path: string): LintResult {
  return lintSource(readFileSync(path, 'utf8'), { file: path })
}
