#!/usr/bin/env node
/**
 * `@bffless/workflow` — the authoring CLI (apps#420). A thin router: `lint`
 * and `index` delegate to `@bffless/workflow-lint`'s published API
 * (`lintFile`, `resolveRuleSet`, `buildIndex`) so the parser/schema/resolver
 * logic has exactly one implementation, and `rename`/`init`/`add` each
 * delegate to their own verb module (./verbs/{rename,init,add}.ts) —
 * `rename` and `init` built on the boundary-aware rename engine
 * (./rewrite.ts), `add` scaffolding new workflow + rule-stub files that line
 * up with it. `publish` is the one verb still landing in a later task of the
 * same plan (docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md).
 *
 * workflow-lint's own CLI (`packages/workflow-lint/src/cli.ts`) is the
 * contract this mirrors — same flags, same exit codes (0 clean, 1
 * errors/warnings, 2 usage/IO error) — but its argument parsing, output
 * formatting and `index` file I/O are private to that package (only
 * `lintFile`/`resolveRuleSet`/`buildIndex` are exported), so that layer is
 * re-implemented here against the public API rather than imported.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildIndex,
  lintFile,
  resolveRuleSet,
  type Counts,
  type IndexFinding,
  type LintResult,
  type RuleSetContext,
} from '@bffless/workflow-lint'
import { readVersion } from './version.js'
import { parseAdd, runAdd } from './verbs/add.js'
import { parseInit, runInit } from './verbs/init.js'
import { parseRename, runRename } from './verbs/rename.js'

const VERBS = ['init', 'rename', 'add', 'lint', 'index', 'publish'] as const
type Verb = (typeof VERBS)[number]
const UNIMPLEMENTED: ReadonlySet<Verb> = new Set(['publish'])

const USAGE = `Usage: workflow <verb> [options]

Verbs:
  init      create a new implementation from any --from repo (or a local path)
  rename    rename an implementation's alias in place, in the current directory
  add       scaffold a new workflow + rule stubs, in the current directory
  lint      lint workflow YAML — delegates to @bffless/workflow-lint
  index     build an implementation's index.json bundle — delegates to @bffless/workflow-lint
  publish   index -> rules push -> upload -> attach               (not yet implemented)

  --version  print the installed @bffless/workflow version

lint and index accept the same flags as workflow-lint's own \`workflow\` CLI:

  lint <file...> [--json] [--quiet] [--rules <dir>] [--alias <alias>] [--path-prefix <p>]
  index <workflows-dir> --out <dir> --impl <alias> --name <display> [options]

rename operates on the current directory's .bffless/workflow.json:

  rename <old> <new> [--dry-run]

add operates on the current directory's .bffless/workflow.json (its alias
picks the rule-set directory rule stubs land in):

  add <name> [--step <path>]…   (default step: a single step whose path is <name>)

init clones (or reads a local copy of) a source repo and copies its package here:

  init <alias> --from <owner>/<repo>|<path> [--path <dir>] [--ref <ref>] [options]

Options (init):
  --from <owner>/<repo>|<path>  source repo or local path (default: bffless/workflow-implementations)
  --path <dir>             the package's location within the source repo (searched if omitted)
  --ref <ref>               branch, tag, or commit SHA to clone (default: the default branch)
  --dest <dir>              where to copy the package (default: ./<alias>; "." for a repo-root implementation)
  --project <owner/name>    the BFFless project this deploys to (required to generate .github/workflows)
  --harness-alias <alias>   which harness alias it deploys under (default: workflow)
  --dry-run                 print the copy/rename/generate plan; write nothing

Options (rename):
  --dry-run        print the rewrite diff report; write nothing

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

Exit codes: 0 = clean (notices allowed), 1 = errors or warnings, 2 = usage/IO error.`

/** Options both verbs take, so a rule set resolves identically either way. */
interface RuleArgs {
  rules?: string
  alias?: string
  pathPrefix?: string
}

interface LintArgs extends RuleArgs {
  verb: 'lint'
  files: string[]
  json: boolean
  quiet: boolean
}

interface IndexArgs extends RuleArgs {
  verb: 'index'
  workflowsDir: string
  out: string
  impl: string
  name: string
  description?: string
  version?: string
  commit?: string
}

/** Flags taking a value, keyed by the field they fill. */
const RULE_FLAGS: Record<string, keyof RuleArgs> = {
  '--rules': 'rules',
  '--alias': 'alias',
  '--path-prefix': 'pathPrefix',
}

const INDEX_FLAGS = ['--out', '--impl', '--name', '--description', '--version', '--commit'] as const

function parseLint(rest: string[]): LintArgs | { error: string } {
  const args: LintArgs = { verb: 'lint', files: [], json: false, quiet: false }
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
    verb: 'index',
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

/** Top-level `*.workflow.yaml`/`*.yaml`/`*.yml` files, in listing order — the order `index.json` lists them in. */
function workflowFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => e.name)
    .sort()
}

/** `<out>/<sub>/*` matching `re`, listed as bundle-relative paths. */
function bundleFiles(out: string, sub: string, re: RegExp): string[] {
  const dir = join(out, sub)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && re.test(e.name))
    .map((e) => `${sub}/${e.name}`)
    .sort()
}

/** Same shape as workflow-lint's `index/write.ts` `landingPage` — the bundle-only alias's fallback page. */
function landingPage(impl: string): string {
  const pattern = impl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>workflow-${impl}</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;margin:3rem auto;max-width:34rem;padding:0 1rem">
<p>workflow-${impl} — a bundle-only alias; open <a id="harness" href="/.bffless/workflows/index.json">the harness</a>.</p>
<script>
  var host = location.hostname.replace(/^${pattern}\\./, 'workflow.')
  if (host !== location.hostname) document.getElementById('harness').href = location.protocol + '//' + host
</script>
</body></html>
`
}

/** `--version` default: the nearest `package.json` at or above the workflows directory. */
function defaultVersion(workflowsDir: string): string {
  let dir = resolve(workflowsDir)
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const version: unknown = JSON.parse(readFileSync(candidate, 'utf8')).version
        if (typeof version === 'string') return version
      } catch {
        // An unreadable package.json is not this command's business to report.
      }
      return '0.0.0'
    }
    const parent = dirname(dir)
    if (parent === dir) return '0.0.0'
    dir = parent
  }
}

/** `--commit` default: CI's `GITHUB_SHA`. No `git` fallback — this runs over `npx` in someone else's repo. */
function defaultCommit(): string {
  return process.env.GITHUB_SHA?.slice(0, 7) ?? 'unknown'
}

/** The `buildIndex` result once a failing lint has already returned. */
type WriteResult = { ok: true; workflowCount: number; indexFile: string } | { ok: false; findings: IndexFinding[] }

/**
 * Everything that touches disk beyond the up-front directory/rules checks:
 * reading the workflow YAMLs, running `buildIndex`, and — only on success —
 * writing the bundle. Split out so `runIndex` can wrap exactly this in a
 * try/catch, matching workflow-lint's own CLI contract (its `runIndex` wraps
 * the equivalent `writeIndex(...)` call the same way): a permission error, a
 * full disk, or a file deleted mid-run must surface as `workflow: <message>`
 * on stderr with exit 2, never an uncaught exception.
 */
function writeIndexBundle(parsed: IndexArgs, rules: RuleSetContext): WriteResult {
  const files = workflowFiles(parsed.workflowsDir)
  const built = buildIndex({
    impl: parsed.impl,
    name: parsed.name,
    description: parsed.description,
    version: parsed.version ?? defaultVersion(parsed.workflowsDir),
    commit: parsed.commit ?? defaultCommit(),
    workflows: files.map((file) => ({ file, yaml: readFileSync(join(parsed.workflowsDir, file), 'utf8') })),
    islands: bundleFiles(parsed.out, 'islands', /\.html$/),
    scripts: bundleFiles(parsed.out, 'scripts', /\.m?js$/),
    rules,
  })

  // Nothing is written for a failing lint: a half-staged bundle whose index
  // predates the failure is worse than no bundle at all (06).
  if (!built.ok) return built

  // The only directory this command owns is cleared before it is written, so
  // a renamed or deleted YAML never lingers in a re-used local out dir. Never
  // `<out>` itself, which holds the islands and scripts someone else staged.
  const workflowDir = join(parsed.out, '.bffless', 'workflows')
  rmSync(workflowDir, { recursive: true, force: true })
  mkdirSync(workflowDir, { recursive: true })
  for (const file of files) copyFileSync(join(parsed.workflowsDir, file), join(workflowDir, file))

  const { workflows, islands, scripts, ...head } = built.index
  const index = { ...head, generatedAt: new Date().toISOString(), workflows, islands, scripts }
  const indexFile = join(workflowDir, 'index.json')
  writeFileSync(indexFile, JSON.stringify(index, null, 2))
  writeFileSync(join(parsed.out, 'index.html'), landingPage(parsed.impl))

  return { ok: true, workflowCount: index.workflows.length, indexFile }
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

  // An explicit --rules that does not resolve is an environment error, not a
  // notice: the caller named the set, so degrading to "skipped the rule
  // check" would publish a bundle whose paths were never actually verified.
  if (parsed.rules && !rules.found) {
    err(`workflow: ${rules.reason}`)
    return 2
  }

  let result: WriteResult
  try {
    result = writeIndexBundle(parsed, rules)
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

  out(`indexed ${result.workflowCount} workflow(s) → ${result.indexFile}`)
  return 0
}

export function runCli(argv: string[], out: (line: string) => void, err: (line: string) => void): number {
  if (argv[0] === '--version') {
    out(readVersion())
    return 0
  }

  const [verb, ...rest] = argv
  if (verb === undefined) {
    err(`workflow: missing verb\n\n${USAGE}`)
    return 2
  }
  if (!(VERBS as readonly string[]).includes(verb)) {
    err(`workflow: unknown verb \`${verb}\`\n\n${USAGE}`)
    return 2
  }
  if (UNIMPLEMENTED.has(verb as Verb)) {
    err(`workflow: ${verb} not implemented`)
    return 2
  }

  if (verb === 'lint') {
    const parsed = parseLint(rest)
    if ('error' in parsed) {
      err(`workflow: ${parsed.error}\n\n${USAGE}`)
      return 2
    }
    return runLint(parsed, out, err)
  }

  if (verb === 'rename') {
    const parsed = parseRename(rest)
    if ('error' in parsed) {
      err(`workflow: ${parsed.error}\n\n${USAGE}`)
      return 2
    }
    return runRename(process.cwd(), parsed, out, err)
  }

  if (verb === 'init') {
    const parsed = parseInit(rest)
    if ('error' in parsed) {
      err(`workflow: ${parsed.error}\n\n${USAGE}`)
      return 2
    }
    return runInit(process.cwd(), parsed, out, err)
  }

  if (verb === 'add') {
    const parsed = parseAdd(rest)
    if ('error' in parsed) {
      err(`workflow: ${parsed.error}\n\n${USAGE}`)
      return 2
    }
    return runAdd(process.cwd(), parsed, out, err)
  }

  // verb === 'index' (the only remaining implemented verb).
  const parsed = parseIndex(rest)
  if ('error' in parsed) {
    err(`workflow: ${parsed.error}\n\n${USAGE}`)
    return 2
  }
  return runIndex(parsed, out, err)
}

/** realpathSync, tolerant of a path that doesn't resolve (falls back to itself). */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// Only run when invoked as a script (not when imported by tests). A published
// `bin` is launched through a symlink (npm) or shim (pnpm) — Node resolves
// the main module through the link, so import.meta.url is already the
// realpath while process.argv[1] is still the link path. Comparing resolved
// paths on both sides keeps this guard true for every `bin` invocation
// (mirrors workflow-lint's cli.ts realpath guard).
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) {
  process.exitCode = runCli(
    process.argv.slice(2),
    (l) => console.log(l),
    (l) => console.error(l),
  )
}
