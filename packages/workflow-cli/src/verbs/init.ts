/**
 * `workflow init <alias> --from <owner>/<repo>|<local-path> [--path <dir>]
 * [--ref <ref>] [--dest <dir>] [--project <owner/name>]
 * [--harness-alias <alias>]` (apps#420, plan Decision 3:
 * docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:19, Decision
 * 10 for the generated workflows).
 *
 * `init` is portable, not coupled to `bffless/workflow-implementations`:
 * `--from` is either a `<owner>/<repo>` GitHub spec (shallow-cloned into a
 * disposable temp dir; a `--ref` that isn't a branch/tag — e.g. a commit SHA
 * — falls back to a full clone + checkout) or an existing local directory,
 * used directly with no clone (the offline path the tests exercise). Inside
 * that source, `.bffless/workflow.json` (../identity.ts) is the discovery
 * contract: `--path` names where the package lives, or — if omitted — the
 * conventional default (`workflows/hello`, matching the plan's own default
 * invocation) is tried first, then the whole tree is searched for
 * candidates. Once found, the package directory is copied into `--dest`
 * (default `./<alias>`; `--dest .` for a repo-root implementation, e.g.
 * bffless.app's dogfood copy) and put through the boundary-aware rename
 * engine (../rewrite.ts) from the source's own alias to the requested one.
 *
 * On top of that, `init` generates the *host* repo's deploy/preview
 * workflows (templates in ../templates/, ported from
 * `workflow-implementations`'s `deploy-hello.yml`/`preview-hello.yml`) —
 * but only when the destination repo actually differs in shape from the
 * package's source layout. The one case where it doesn't is copying a
 * repo-root package into a repo-root destination (`--path` and `--dest`
 * both resolve to `.`): that's forking a whole single-implementation repo
 * verbatim, whose own top-level `.github/workflows/` — if any — travels
 * with the copy, so generating a second, competing set on top of it would
 * be wrong. Every other shape (a package nested under `--path` and/or
 * landing under a `--dest` subdirectory) is "initializing into a host
 * repo," where nothing already knows how to deploy this alias — so
 * `--project` (the target BFFless project, per the repo≠project lesson
 * bffless.app's own `build.yml` documents) becomes required. Generated
 * files are written only if absent — `init` never clobbers a host repo's
 * own hand-edited workflow.
 *
 * Before any of that writes anything, a destination preflight
 * (`findDestinationConflicts`) checks every path the copy would actually
 * land against what's already at `--dest` — real run or `--dry-run` alike —
 * and refuses (exit 2, naming the colliding paths) rather than silently
 * overwriting. This matters most for `--dest .`: the destination is very
 * often an existing, populated host repo (Task 8's dogfood copy into
 * `bffless.app` is exactly this shape), so only paths the package would
 * actually write are conflicts — everything else already at the
 * destination is the host repo's own business and is left alone.
 */
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readIdentity, writeIdentity, type Identity } from '../identity.js'
import { ALIAS_RE, RESERVED_ALIASES, renamePass, type RenameReport } from '../rewrite.js'

type Print = (line: string) => void

export interface InitArgs {
  alias: string
  from: string
  path?: string
  ref?: string
  dest?: string
  project?: string
  harnessAlias: string
  dryRun: boolean
}

const DEFAULT_FROM = 'bffless/workflow-implementations'
const DEFAULT_PATH = 'workflows/hello'

/** Flags that take a value — everything else starting with `--` is unknown. */
const VALUE_FLAGS = new Set(['--from', '--path', '--ref', '--dest', '--project', '--harness-alias'])

/** `--dry-run` and the two positional/required-value flags aside, everything else is a plain value flag. */
export function parseInit(rest: string[]): InitArgs | { error: string } {
  let dryRun = false
  const positional: string[] = []
  const values: Record<string, string> = {}

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? ''
    if (a === '--dry-run') {
      dryRun = true
    } else if (VALUE_FLAGS.has(a)) {
      const value = rest[++i]
      if (value === undefined || value.startsWith('--')) return { error: `${a} needs a value` }
      values[a] = value
    } else if (a.startsWith('--')) {
      return { error: `unknown option ${a}` }
    } else {
      positional.push(a)
    }
  }

  if (positional.length === 0) return { error: 'usage: init <alias> --from <owner>/<repo> [--path <dir>] [--ref <ref>]' }
  if (positional.length > 1) return { error: 'init takes exactly one argument: <alias>' }

  return {
    alias: positional[0] as string,
    from: values['--from'] ?? DEFAULT_FROM,
    path: values['--path'],
    ref: values['--ref'],
    dest: values['--dest'],
    project: values['--project'],
    harnessAlias: values['--harness-alias'] ?? 'workflow',
    dryRun,
  }
}

/** Same alias rules `renamePass` enforces (../rewrite.ts) — checked up front so a bad alias never triggers a clone. */
function validateAlias(alias: string): string | undefined {
  if (RESERVED_ALIASES.includes(alias)) return `alias "${alias}" is reserved (${RESERVED_ALIASES.join(', ')})`
  if (!ALIAS_RE.test(alias)) return `alias "${alias}" is not a valid alias: expected ${ALIAS_RE}`
  return undefined
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

/** Strips a leading `./`, collapses an empty/`.` path to `.`. */
function normalizeRelPath(p: string): string {
  const stripped = toPosix(p).replace(/^\.\/+/, '')
  return stripped === '' || stripped === '.' ? '.' : stripped.replace(/\/+$/, '')
}

const CANDIDATE_SKIP_DIRS = new Set(['node_modules', '.git', 'vendor'])

/** Every directory under `root` (root included) that carries its own `.bffless/workflow.json`, as `.`-relative POSIX paths. */
function findIdentityCandidates(root: string): string[] {
  const out: string[] = []
  if (existsSync(join(root, '.bffless', 'workflow.json'))) out.push('.')
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || CANDIDATE_SKIP_DIRS.has(entry.name)) continue
      const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`
      if (existsSync(join(dir, entry.name, '.bffless', 'workflow.json'))) out.push(childRel)
      walk(join(dir, entry.name), childRel)
    }
  }
  walk(root, '.')
  return out.sort()
}

/**
 * Resolves where the package lives inside `repoRoot`. An explicit `--path`
 * is checked directly (candidates are only computed to build the error
 * message if it's wrong); omitted, the conventional default is tried first,
 * then a repo-wide search — one candidate wins outright, zero or several is
 * an error naming what was found (see module doc).
 */
function resolvePackagePath(repoRoot: string, requestedPath: string | undefined): { path: string } | { error: string } {
  if (requestedPath !== undefined) {
    const normalized = normalizeRelPath(requestedPath)
    const dir = normalized === '.' ? repoRoot : join(repoRoot, normalized)
    if (existsSync(join(dir, '.bffless', 'workflow.json'))) return { path: normalized }
    const candidates = findIdentityCandidates(repoRoot)
    return {
      error:
        `no .bffless/workflow.json found under --path ${requestedPath} — ` +
        (candidates.length > 0 ? `candidates found: ${candidates.join(', ')}` : 'no candidates found in this repo either'),
    }
  }

  if (existsSync(join(repoRoot, DEFAULT_PATH, '.bffless', 'workflow.json'))) return { path: DEFAULT_PATH }

  const candidates = findIdentityCandidates(repoRoot)
  if (candidates.length === 1) return { path: candidates[0] as string }
  if (candidates.length === 0) return { error: 'no .bffless/workflow.json found anywhere in this repo — pass --path' }
  return { error: `--path is required: multiple implementations found — ${candidates.join(', ')}` }
}

/** A local directory is used as-is (the offline path tests take); otherwise `from` must be an `<owner>/<repo>` GitHub spec to clone. */
function resolveSource(cwd: string, from: string, ref: string | undefined): { repoRoot: string; cleanup: () => void } {
  const asLocal = resolve(cwd, from)
  if (existsSync(asLocal) && statSync(asLocal).isDirectory()) {
    return { repoRoot: asLocal, cleanup: () => {} }
  }
  return cloneRepo(from, ref)
}

/**
 * `git clone --depth 1 https://github.com/<owner>/<repo>` into a disposable
 * temp dir, `--branch <ref>` when given. A shallow clone can only fetch a
 * branch or tag by name — if `--ref` turns out to be a commit SHA, the
 * shallow attempt fails and this falls back to a full clone + `checkout`.
 */
function cloneRepo(fromSpec: string, ref: string | undefined): { repoRoot: string; cleanup: () => void } {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fromSpec)) {
    throw new Error(`--from "${fromSpec}" is neither an existing local path nor an <owner>/<repo> spec`)
  }
  const url = `https://github.com/${fromSpec}`
  const tmp = mkdtempSync(join(tmpdir(), 'workflow-init-src-'))
  try {
    if (ref) {
      try {
        execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', ref, url, tmp], { stdio: 'pipe' })
      } catch {
        rmSync(tmp, { recursive: true, force: true })
        mkdirSync(tmp, { recursive: true })
        execFileSync('git', ['clone', '--quiet', url, tmp], { stdio: 'pipe' })
        execFileSync('git', ['checkout', '--quiet', ref], { cwd: tmp, stdio: 'pipe' })
      }
    } else {
      execFileSync('git', ['clone', '--quiet', '--depth', '1', url, tmp], { stdio: 'pipe' })
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw new Error(`git clone of ${fromSpec} failed: ${(e as Error).message}`, { cause: e })
  }
  return { repoRoot: tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

/** Every file under `root` (root-relative POSIX paths), `.git` excluded — same exclusion `cpSync`'s filter applies when actually copying. */
function listCopyableFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, childRel)
      else if (entry.isFile()) out.push(childRel)
    }
  }
  walk(root, '')
  return out.sort()
}

/**
 * Conflicts between what `init` is about to copy and what's already sitting
 * at `destDir` — checked before any write, real run or dry run alike, so a
 * populated `--dest .` (the Task 8 dogfood shape: copying into the real,
 * non-empty `bffless.app` repo) is caught cleanly instead of silently
 * overwritten. A path only counts as a conflict when the copy would
 * actually land a file there — i.e. it appears in `packageFiles` — so an
 * *unrelated* existing file at the destination (anything the package
 * doesn't ship) is never flagged; that's the entire point of `--dest .`
 * landing a package inside an existing host repo. `destDir` itself existing
 * as a plain file (not a directory) is its own, single conflict: `mkdirSync`
 * would throw `ENOTDIR` on it, so it's caught here instead, before that
 * throw ever happens.
 */
function findDestinationConflicts(destDir: string, packageFiles: string[]): string[] {
  if (existsSync(destDir) && !statSync(destDir).isDirectory()) {
    return [`${destDir} (exists and is not a directory)`]
  }
  return packageFiles.filter((f) => existsSync(join(destDir, f)))
}

const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url))
const DEPLOY_TMPL = readFileSync(join(TEMPLATES_DIR, 'deploy.yml.tmpl'), 'utf8')
const PREVIEW_TMPL = readFileSync(join(TEMPLATES_DIR, 'preview.yml.tmpl'), 'utf8')

function render(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/__([A-Z_]+)__/g, (_match, key: string) => {
    if (!(key in vars)) throw new Error(`template placeholder __${key}__ has no value`)
    return vars[key] as string
  })
}

interface GeneratedPaths {
  pathGlob: string
  buildLine: string
  distPath: string
  workflowsPath: string
  rulesPath: string
  indexJsonPath: string
}

/** Every path/command the templates need, relative to the destination repo root — empty prefix when `--dest .`. */
function computeGeneratedPaths(destRel: string, alias: string): GeneratedPaths {
  const prefix = destRel === '.' ? '' : `${destRel}/`
  return {
    pathGlob: destRel === '.' ? '**' : `${destRel}/**`,
    buildLine: destRel === '.' ? 'pnpm run build' : `pnpm --filter ./${destRel} run build`,
    distPath: `${prefix}dist`,
    workflowsPath: `${prefix}.bffless/workflows`,
    rulesPath: `${prefix}.bffless/proxy-rules/${alias}`,
    indexJsonPath: `${prefix}dist/.bffless/workflows/index.json`,
  }
}

interface GeneratedFile {
  relFile: string
  file: string
  content: string
}

/** Renders `deploy-<alias>.yml`/`preview-<alias>.yml` for `cwd` (the destination repo root) — absolute + repo-relative paths, not yet written. */
function buildGeneratedFiles(cwd: string, alias: string, destRel: string, project: string, harnessAlias: string): GeneratedFile[] {
  const paths = computeGeneratedPaths(destRel, alias)
  const name = alias.charAt(0).toUpperCase() + alias.slice(1)
  const description = `${alias} — a BFFless Workflow implementation, created with @bffless/workflow init.`
  const vars: Record<string, string> = {
    ALIAS: alias,
    NAME: name,
    DESCRIPTION: description,
    REPOSITORY: project,
    HARNESS_ALIAS: harnessAlias,
    PATH_GLOB: paths.pathGlob,
    BUILD_LINE: paths.buildLine,
    DIST_PATH: paths.distPath,
    WORKFLOWS_PATH: paths.workflowsPath,
    RULES_PATH: paths.rulesPath,
    INDEX_JSON_PATH: paths.indexJsonPath,
  }
  return [
    { rel: `.github/workflows/deploy-${alias}.yml`, tmpl: DEPLOY_TMPL },
    { rel: `.github/workflows/preview-${alias}.yml`, tmpl: PREVIEW_TMPL },
  ].map(({ rel, tmpl }) => ({ relFile: rel, file: join(cwd, rel), content: render(tmpl, vars) }))
}

function printRenameReport(out: Print, tag: string, report: RenameReport, oldAlias: string, newAlias: string): void {
  for (const [from, to] of report.renames) out(`${tag}rename ${from} -> ${to}`)
  for (const e of report.edits) out(`${tag}edit ${e.file} (${e.count} match${e.count === 1 ? '' : 'es'})`)
  out(`${tag}identity ${oldAlias} -> ${newAlias}`)
}

function printGenerated(out: Print, tag: string, files: GeneratedFile[], skipped: string[]): void {
  for (const f of files) {
    out(skipped.includes(f.relFile) ? `${tag}skip ${f.relFile} (already exists)` : `${tag}generate ${f.relFile}`)
  }
}

/** The issue's "print the manual steps" sketch (Decision 10), made concrete. Advisory only — never gates the exit code. */
function printManualSteps(out: Print, project: string | undefined, harnessAlias: string): void {
  out('')
  out('Next steps:')
  out('  1. Create or choose the GitHub repository this implementation will live in, and push this commit there.')
  out('  2. On that repository, set the BFFLESS_API_KEY secret and the BFFLESS_URL variable (Settings -> Secrets and variables -> Actions).')
  out(
    `  3. Make sure that repository has contributor role on the "${project ?? '<project>'}" BFFless project — ` +
      `the target of harness alias "${harnessAlias}".`,
  )
  out('  4. If that BFFless instance does not already have a Workflow harness installed, install it from the catalog (Admin -> Apps) before the first deploy.')
}

/**
 * Runs `init` rooted at `cwd` (the destination repo root — a parameter, not
 * `process.cwd()` read internally, for the same testability reason
 * `runRename` takes `dir`: cli.ts passes `process.cwd()` for the real
 * invocation).
 */
export function runInit(cwd: string, parsed: InitArgs, out: Print, err: Print): number {
  const aliasError = validateAlias(parsed.alias)
  if (aliasError) {
    err(`workflow: ${aliasError}`)
    return 2
  }

  const destRel = normalizeRelPath(parsed.dest ?? parsed.alias)
  const destDir = resolve(cwd, destRel)

  let source: { repoRoot: string; cleanup: () => void }
  try {
    source = resolveSource(cwd, parsed.from, parsed.ref)
  } catch (e) {
    err(`workflow: ${(e as Error).message}`)
    return 2
  }

  try {
    const pathResult = resolvePackagePath(source.repoRoot, parsed.path)
    if ('error' in pathResult) {
      err(`workflow: ${pathResult.error}`)
      return 2
    }
    const packagePath = pathResult.path
    const packageDir = packagePath === '.' ? source.repoRoot : join(source.repoRoot, packagePath)

    let identity: Identity
    try {
      identity = readIdentity(packageDir)
    } catch (e) {
      err(`workflow: ${(e as Error).message}`)
      return 2
    }

    // Skipped only for a repo-root package landing at a repo-root
    // destination — a whole single-implementation repo forked verbatim,
    // whose own top-level CI (if any) travels with the copy. Every other
    // shape is "initializing into a host repo" — see module doc.
    const wouldGenerate = !(packagePath === '.' && destRel === '.')
    if (wouldGenerate && !parsed.project) {
      err(
        `workflow: --project <owner/name> is required to generate .github/workflows/{deploy,preview}-${parsed.alias}.yml ` +
          '— the BFFless project this implementation deploys to (often not the same as the GitHub repo it lives in)',
      )
      return 2
    }

    const generatedFiles =
      wouldGenerate && parsed.project ? buildGeneratedFiles(cwd, parsed.alias, destRel, parsed.project, parsed.harnessAlias) : []
    const skippedFiles = generatedFiles.filter((g) => existsSync(g.file)).map((g) => g.relFile)
    const packageFiles = listCopyableFiles(packageDir)
    const sourceDescr = packagePath === '.' ? parsed.from : `${parsed.from}/${packagePath}`

    // A preflight, not a write: catches a populated destination — most
    // pointedly a populated `--dest .` — before anything is touched. Real
    // run and dry run alike, so `--dry-run` previews the failure exactly as
    // the real run would hit it (see module doc / findDestinationConflicts).
    const conflicts = findDestinationConflicts(destDir, packageFiles)
    if (conflicts.length > 0) {
      const tag = parsed.dryRun ? '(dry run) ' : ''
      err(
        `workflow: ${tag}${destRel}/ already has ${conflicts.length} path(s) init would overwrite — refusing to clobber the destination:`,
      )
      for (const c of conflicts) err(`  ${c}`)
      return 2
    }

    if (parsed.dryRun) {
      const tag = '(dry run) '
      out(`${tag}copy ${sourceDescr} -> ${destRel}/ (${packageFiles.length} file(s))`)
      for (const f of packageFiles) out(`${tag}  ${f}`)

      // The report has to reflect the actual post-copy file contents (the
      // rename engine reads files off disk), but nothing may be written to
      // `destDir` — so stage a disposable copy purely to compute it.
      const stage = mkdtempSync(join(tmpdir(), 'workflow-init-stage-'))
      try {
        cpSync(packageDir, stage, { recursive: true, filter: (p) => basename(p) !== '.git' })
        const report = renamePass(stage, identity.alias, parsed.alias, { dryRun: true })
        printRenameReport(out, tag, report, identity.alias, parsed.alias)
      } finally {
        rmSync(stage, { recursive: true, force: true })
      }

      printGenerated(out, tag, generatedFiles, skippedFiles)
      printManualSteps(out, parsed.project, parsed.harnessAlias)
      out(`${tag}would init ${parsed.alias} in ${destRel}/`)
      return 0
    }

    try {
      mkdirSync(destDir, { recursive: true })
      cpSync(packageDir, destDir, { recursive: true, filter: (p) => basename(p) !== '.git' })
    } catch (e) {
      err(`workflow: ${(e as Error).message}`)
      return 2
    }

    let report: RenameReport
    try {
      report = renamePass(destDir, identity.alias, parsed.alias, { dryRun: false })
    } catch (e) {
      err(`workflow: ${(e as Error).message}`)
      return 2
    }

    try {
      writeIdentity(destDir, { alias: parsed.alias, harness: parsed.harnessAlias })
    } catch (e) {
      err(`workflow: ${(e as Error).message}`)
      return 2
    }

    try {
      for (const g of generatedFiles) {
        if (existsSync(g.file)) continue
        mkdirSync(dirname(g.file), { recursive: true })
        writeFileSync(g.file, g.content)
      }
    } catch (e) {
      err(`workflow: ${(e as Error).message}`)
      return 2
    }

    out(`copy ${sourceDescr} -> ${destRel}/ (${packageFiles.length} file(s))`)
    for (const f of packageFiles) out(`  ${f}`)
    printRenameReport(out, '', report, identity.alias, parsed.alias)
    printGenerated(out, '', generatedFiles, skippedFiles)
    printManualSteps(out, parsed.project, parsed.harnessAlias)
    out(`✔ initialized ${parsed.alias} in ${destRel}/`)
    return 0
  } finally {
    source.cleanup()
  }
}
