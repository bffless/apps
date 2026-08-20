import { readFileSync } from 'node:fs'
import { lintSource, type LintResult } from './lint.js'

export { lintSource, loadDefinition, type LintResult, type LoadResult } from './lint.js'
export type { Finding, Severity, Counts } from './findings.js'
export { toDefinition, type Definition, type Job, type Step } from './model/definition.js'

export function lintFile(path: string): LintResult {
  return lintSource(readFileSync(path, 'utf8'), { file: path })
}
