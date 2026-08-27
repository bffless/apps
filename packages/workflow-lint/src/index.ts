import { readFileSync } from 'node:fs'
import { lintSource, type LintOptions, type LintResult } from './lint.js'

export { lintSource, loadDefinition, type LintOptions, type LintResult, type LoadResult } from './lint.js'
export type { Finding, Severity, Counts } from './findings.js'
export { toDefinition, type Definition, type Job, type Step } from './model/definition.js'
export { resolveRuleSet, scanRuleSet } from './rules/scan.js'
export type { RuleEntry, RuleSetContext, RuleSetIndex, RuleSetUnresolved } from './rules/match.js'

export function lintFile(path: string, opts: Omit<LintOptions, 'file'> = {}): LintResult {
  return lintSource(readFileSync(path, 'utf8'), { ...opts, file: path })
}
