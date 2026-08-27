#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { lintFile, resolveRuleSet, type LintResult, type RuleSetContext } from './index.js'
import { defaultCommit, defaultVersion, writeIndex } from './index/write.js'
import type { Counts } from './findings.js'

const USAGE = `Usage: workflow lint <file...> [--json] [--quiet] [--rules <dir>] [--alias <alias>] [--path-prefix <p>]
       workflow index <workflows-dir> --out <dir> --impl <alias> --name <display> [options]

Lints BFFless Workflow YAML: schema (workflow.schema.json), \${{ }} expressions
and the static checks from the spec (apps/workflow/docs/spec/).

\`index\` is the publish step: it lints every workflow in <workflows-dir> and,
only if they all pass, writes the bundle's <out>/.bffless/workflows/ (the YAMLs
plus the generated index.json the harness reads) and a landing index.html.

Options (lint):
  --json           machine-readable output (one stable shape for wrappers)
  --quiet          hide notices

Options (index):
  --out <dir>          bundle root; islands/*.html and scripts/*.js already
                       staged there are listed in index.json
  --impl <alias>       the alias the bundle deploys to, e.g. hello
  --name <display>     display name, shown on the Implementations screen
  --description <text> one line about the bundle
  --version <v>        default: the nearest package.json above <workflows-dir>
  --commit <sha>       default: GITHUB_SHA (7 chars), else "unknown"

Options (both):
  --rules <dir>        the implementation's proxy-rule set, so every relative
                       \`with.path\` can be checked against the rule that serves it
  --alias <alias>      which set under .bffless/proxy-rules/ to use (and the alias
                       it deploys to); only needed when the search finds several
  --path-prefix <p>    the prefix the publisher prepends to every derived
                       pathPattern at sync time (\`--path-prefix /api/hello\`), so
                       a prefix-free rule set resolves the way it will once live

Without --rules the set is looked for in the nearest .bffless/proxy-rules above
each file; when none is found the rule check is skipped with a notice.

Exit codes: 0 = clean (notices allowed), 1 = errors or warnings, 2 = usage/IO error.`

/** Options both verbs take, so a rule set resolves identically either way. */
interface RuleArgs {
  rules?: string
  alias?: string
  pathPrefix?: string
}

interface LintArgs extends RuleArgs {
  command: 'lint'
  files: string[]
  json: boolean
  quiet: boolean
}

interface IndexArgs extends RuleArgs {
  command: 'index'
  workflowsDir: string
  out: string
  impl: string
  name: string
  description?: string
  version?: string
  commit?: string
}

type Args = LintArgs | IndexArgs

/** Flags taking a value, keyed by the field they fill. */
const RULE_FLAGS: Record<string, keyof RuleArgs> = {
  '--rules': 'rules',
  '--alias': 'alias',
  '--path-prefix': 'pathPrefix',
}

const INDEX_FLAGS = ['--out', '--impl', '--name', '--description', '--version', '--commit'] as const

function parseArgs(argv: string[]): Args | { error: string } {
  const [command, ...rest] = argv
  if (command === 'lint') return parseLint(rest)
  if (command === 'index') return parseIndex(rest)
  return { error: command ? `unknown command \`${command}\`` : 'missing command' }
}

function parseLint(rest: string[]): LintArgs | { error: string } {
  const args: LintArgs = { command: 'lint', files: [], json: false, quiet: false }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? ''
    if (a === '--json') args.json = true
    else if (a === '--quiet') args.quiet = true
    else if (a in RULE_FLAGS) {
      const value = rest[++i]
      if (value === undefined || value.startsWith('--')) return { error: `${a} needs a value` }
      args[RULE_FLAGS[a] as keyof RuleArgs] = value
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` }
    else args.files.push(a)
  }
  if (args.files.length === 0) return { error: 'no files given' }
  return args
}

function parseIndex(rest: string[]): IndexArgs | { error: string } {
  const values: Record<string, string> = {}
  const positional: string[] = []
  const ruleArgs: RuleArgs = {}

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? ''
    if (a in RULE_FLAGS || (INDEX_FLAGS as readonly string[]).includes(a)) {
      const value = rest[++i]
      if (value === undefined || value.startsWith('--')) return { error: `${a} needs a value` }
      if (a in RULE_FLAGS) ruleArgs[RULE_FLAGS[a] as keyof RuleArgs] = value
      else values[a] = value
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` }
    else positional.push(a)
  }

  const workflowsDir = positional[0]
  if (workflowsDir === undefined) return { error: 'no workflows directory given' }
  if (positional.length > 1) return { error: 'index takes one workflows directory' }
  for (const flag of ['--out', '--impl', '--name'] as const) {
    if (values[flag] === undefined) return { error: `${flag} is required` }
  }

  return {
    command: 'index',
    workflowsDir,
    out: values['--out'] as string,
    impl: values['--impl'] as string,
    name: values['--name'] as string,
    description: values['--description'],
    version: values['--version'],
    commit: values['--commit'],
    ...ruleArgs,
  }
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

function runLint(parsed: LintArgs, out: (line: string) => void, err: (line: string) => void): number {
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
      ctx = resolveRuleSet({
        file,
        rulesDir: parsed.rules,
        alias: parsed.alias,
        pathPrefix: parsed.pathPrefix,
      })
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

function runIndex(parsed: IndexArgs, out: (line: string) => void, err: (line: string) => void): number {
  if (!existsSync(parsed.workflowsDir)) {
    err(`workflow: no such directory: ${parsed.workflowsDir}`)
    return 2
  }

  // resolveRuleSet searches upward from a file's directory; the workflows
  // directory is what we have, so name a path inside it. Only its dirname is read.
  const rules = resolveRuleSet({
    file: join(parsed.workflowsDir, 'index.json'),
    rulesDir: parsed.rules,
    alias: parsed.alias,
    pathPrefix: parsed.pathPrefix,
  })

  let result
  try {
    result = writeIndex({
      workflowsDir: parsed.workflowsDir,
      out: parsed.out,
      impl: parsed.impl,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version ?? defaultVersion(parsed.workflowsDir),
      commit: parsed.commit ?? defaultCommit(),
      rules,
    })
  } catch (e) {
    err(`workflow: ${(e as Error).message}`)
    return 2
  }

  if (!result.ok) {
    err(`workflow: ${result.findings.length} finding(s) — a failing lint is never published:`)
    for (const f of result.findings) {
      const pos = f.pos ? `${f.pos.line}:${f.pos.col}` : '-'
      err(`  ${f.file}  ${pos}  ${f.severity}  ${f.rule}  ${f.message}`)
    }
    return 1
  }

  out(`indexed ${result.index.workflows.length} workflow(s) → ${result.indexFile}`)
  return 0
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
  return parsed.command === 'lint' ? runLint(parsed, out, err) : runIndex(parsed, out, err)
}

// Only run when invoked as a script (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(
    process.argv.slice(2),
    (l) => console.log(l),
    (l) => console.error(l),
  )
}
