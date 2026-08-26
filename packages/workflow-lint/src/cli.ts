#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lintFile, resolveRuleSet, type LintResult, type RuleSetContext } from './index.js'
import type { Counts } from './findings.js'

const USAGE = `Usage: workflow lint <file...> [--json] [--quiet] [--rules <dir>] [--alias <alias>]

Lints BFFless Workflow YAML: schema (workflow.schema.json), \${{ }} expressions
and the static checks from the spec (apps/workflow/docs/spec/).

Options:
  --json           machine-readable output (one stable shape for wrappers)
  --quiet          hide notices
  --rules <dir>    the implementation's proxy-rule set, so every relative
                   \`with.path\` can be checked against the rule that serves it
  --alias <alias>  which set under .bffless/proxy-rules/ to use (and the alias
                   it deploys to); only needed when the search finds several

Without --rules the set is looked for in the nearest .bffless/proxy-rules above
each file; when none is found the rule check is skipped with a notice.

Exit codes: 0 = clean (notices allowed), 1 = errors or warnings, 2 = usage/IO error.`

interface Args {
  files: string[]
  json: boolean
  quiet: boolean
  rules?: string
  alias?: string
}

function parseArgs(argv: string[]): Args | { error: string } {
  const [command, ...rest] = argv
  if (command !== 'lint') {
    return { error: command ? `unknown command \`${command}\`` : 'missing command' }
  }
  const args: Args = { files: [], json: false, quiet: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? ''
    if (a === '--json') args.json = true
    else if (a === '--quiet') args.quiet = true
    else if (a === '--rules' || a === '--alias') {
      const value = rest[++i]
      if (value === undefined || value.startsWith('--')) return { error: `${a} needs a value` }
      if (a === '--rules') args.rules = value
      else args.alias = value
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` }
    else args.files.push(a)
  }
  if (args.files.length === 0) return { error: 'no files given' }
  return args
}

function human(results: LintResult[], quiet: boolean): string {
  const lines: string[] = []
  for (const r of results) {
    const shown = quiet ? r.findings.filter((f) => f.severity !== 'notice') : r.findings
    if (shown.length === 0) continue
    lines.push(r.file ?? '(stdin)')
    for (const f of shown) {
      const pos = f.pos ? `${f.pos.line}:${f.pos.col}` : '-'
      lines.push(`  ${pos}  ${f.severity}  ${f.rule}  ${f.message}${f.path ? `  [${f.path}]` : ''}`)
      if (f.hint) lines.push(`      hint: ${f.hint}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function summarize(results: LintResult[]): Counts {
  return results.reduce(
    (acc, r) => ({
      errors: acc.errors + r.counts.errors,
      warnings: acc.warnings + r.counts.warnings,
      notices: acc.notices + r.counts.notices,
    }),
    { errors: 0, warnings: 0, notices: 0 },
  )
}

export function runCli(
  argv: string[],
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    err(`workflow: ${parsed.error}\n\n${USAGE}`)
    return 2
  }

  const missing = parsed.files.filter((f) => !existsSync(f))
  if (missing.length > 0) {
    for (const f of missing) err(`workflow: no such file: ${f}`)
    return 2
  }

  // Resolution reads the rule set off disk, so memoize it: --rules is one set
  // for the whole run, and a search only ever depends on the file's directory.
  const resolved = new Map<string, RuleSetContext>()
  const rulesFor = (file: string): RuleSetContext => {
    const key = parsed.rules ?? dirname(file)
    let ctx = resolved.get(key)
    if (!ctx) {
      ctx = resolveRuleSet({ file, rulesDir: parsed.rules, alias: parsed.alias })
      resolved.set(key, ctx)
    }
    return ctx
  }

  const results = parsed.files.map((f) => lintFile(f, { rules: rulesFor(f) }))
  const total = summarize(results)

  if (parsed.json) {
    out(
      JSON.stringify(
        {
          version: 1,
          files: results.map((r) => ({ file: r.file, findings: r.findings, counts: r.counts })),
          summary: total,
        },
        null,
        2,
      ),
    )
  } else {
    const body = human(results, parsed.quiet)
    if (body) out(body)
    const dirty = total.errors + total.warnings > 0
    out(
      `${dirty ? '✖' : '✔'} ${results.length} file(s): ` +
        `${total.errors} error(s), ${total.warnings} warning(s), ${total.notices} notice(s)`,
    )
  }

  return total.errors + total.warnings > 0 ? 1 : 0
}

// Only run when invoked as a script (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(
    process.argv.slice(2),
    (l) => console.log(l),
    (l) => console.error(l),
  )
}
