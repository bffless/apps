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
 * candidates. Once found, the package directory is staged into a disposable
 * temp dir, put through the boundary-aware rename engine (../rewrite.ts)
 * there — from the source's own alias to the requested one — and only that
 * already-renamed staged copy is written into `--dest` (default `./<alias>`;
 * `--dest .` for a repo-root implementation, e.g. bffless.app's dogfood
 * copy). Staging first, rather than copying straight into `--dest` and
 * renaming in place, is deliberate (C1, apps#420 whole-branch review): for
 * `--dest .` the destination is very often the host repo itself, and the
 * rename engine's textual pass walks every file it's pointed at — running it
 * on `destDir` directly would rewrite host files the copy never touched
 * (anything that happens to contain the old alias as an ordinary word) right
 * alongside the package's own. Scoping the pass to the staged copy makes
 * that impossible: it only ever sees the files this `init` actually copies.
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
 * (`findDestinationConflicts`) checks every path the staged, post-rename
 * copy would actually land against what's already at `--dest` — real run or
 * `--dry-run` alike — and refuses (exit 2, naming the colliding paths and
 * suggesting `--skip-existing`) rather than silently overwriting. This
 * matters most for `--dest .`: the destination is very often an existing,
 * populated host repo (Task 8's dogfood copy into `bffless.app` is exactly
 * this shape), so only paths the package would actually write are
 * conflicts — everything else already at the destination is the host
 * repo's own business and is left alone. `--skip-existing` (I5) turns that
 * refusal into a merge: colliding paths are left exactly as the host has
 * them (not copied at all, reported under a "skipped" section), and every
 * non-colliding package file still lands, renamed, same as always — unless
 * the collision set includes a tier-1 file (package.json, tsconfig.json, a
 * lockfile, vite.config.*), in which case the skip would orphan the copy or
 * break the host's build, so init refuses outright and recommends `--dest
 * <subdir>` (#559). The report additionally lists every pre-existing
 * destination directory the copy merged files into, since directory-level
 * merges never show up as file conflicts (#559).
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
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
  skipExisting: boolean
}

const DEFAULT_FROM = 'bffless/workflow-implementations'
const DEFAULT_PATH = 'workflows/hello'

/** Flags that take a value — everything else starting with `--` is unknown. */
const VALUE_FLAGS = new Set(['--from', '--path', '--ref', '--dest', '--project', '--harness-alias'])

/** `--dry-run`/`--skip-existing` and the two positional/required-value flags aside, everything else is a plain value flag. */
export function parseInit(rest: string[]): InitArgs | { error: string } {
  let dryRun = false
  let skipExisting = false
  const positional: string[] = []
  const values: Record<string, string> = {}

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? ''
    if (a === '--dry-run') {
      dryRun = true
    } else if (a === '--skip-existing') {
      skipExisting = true
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
    skipExisting,
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
 * actually land a file there — i.e. it appears in `stagedFiles`, the
 * *post-rename* file list computed off the staged copy (see `runInit`) —
 * so an *unrelated* existing file at the destination (anything the package
 * doesn't ship) is never flagged; that's the entire point of `--dest .`
 * landing a package inside an existing host repo. Using the post-rename
 * list (rather than the raw source listing) matters whenever the rule-set
 * directory gets renamed: the file actually lands at
 * `.bffless/proxy-rules/<newAlias>/…`, not the old-alias path, so that's
 * what has to be checked against the destination.
 */
function findDestinationConflicts(destDir: string, stagedFiles: string[]): string[] {
  return stagedFiles.filter((f) => existsSync(join(destDir, f)))
}

/**
 * Tier-1: files whose collision `--skip-existing` must NOT resolve in the
 * host's favour (#559, from #420's Phase-4 dogfood). Skipping the package's
 * `package.json` orphans the whole copy — its dependencies and build script
 * never arrive, so nothing can install or build the copied files; skipping
 * `tsconfig.json` leaves the host's `include` sweeping up the copy's test
 * files, breaking the HOST's own build (measured: 10 TS2307 errors).
 * Lockfiles and `vite.config.*` are the same class. Matched by basename at
 * any depth — the friction evidence is all root-level, but a nested
 * `package.json` is load-bearing for the same reason.
 */
const TIER1_BASENAMES = new Set(['package.json', 'tsconfig.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'])
const TIER1_VITE_CONFIG_RE = /^vite\.config\.[cm]?[jt]s$/

function isTier1(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  return TIER1_BASENAMES.has(base) || TIER1_VITE_CONFIG_RE.test(base)
}

interface DirMerge {
  dir: string
  count: number
}

/**
 * Top-level directories the copy writes into that already exist at the
 * destination (#559): the conflict check is file-level, so a copy into a
 * host that already has e.g. `scripts/` — with no individual filename
 * clashing — used to happen with no report at all. Computed off the files
 * the run will actually write (post-skip), BEFORE anything is copied.
 */
function findDirectoryMerges(destDir: string, copiedFiles: string[]): DirMerge[] {
  const counts = new Map<string, number>()
  for (const f of copiedFiles) {
    const slash = f.indexOf('/')
    if (slash === -1) continue
    const top = f.slice(0, slash)
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([dir]) => {
      const existing = join(destDir, dir)
      return existsSync(existing) && statSync(existing).isDirectory()
    })
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
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

/**
 * `--skip-existing`'s report section (I5): every path that already existed
 * at the destination and was therefore left untouched — the host's own
 * version wins, and merging the package's version in (if wanted at all) is
 * left to the caller.
 */
function printSkipped(out: Print, tag: string, skipped: string[]): void {
  if (skipped.length === 0) return
  out(`${tag}skipped (already exists) — merge by hand:`)
  for (const s of skipped) out(`${tag}  ${s}`)
}

/** #559: every pre-existing destination directory the copy added files into — real run and dry run alike. */
function printMerged(out: Print, tag: string, merges: DirMerge[]): void {
  for (const m of merges) out(`${tag}merged into existing ${m.dir}/ (${m.count} file${m.count === 1 ? '' : 's'} added)`)
}

/**
 * The issue's "print the manual steps" sketch (Decision 10), made concrete.
 * Advisory only — never gates the exit code. Step 5 (I6) only applies when
 * the generated workflows land the package under a subdirectory of the
 * destination repo (`destRel !== '.'`): `computeGeneratedPaths`'s
 * `buildLine` then reads `pnpm --filter ./<destRel> run build`, which only
 * works once `<destRel>` is a member of the host repo's pnpm workspace —
 * something `init` has no business assuming is already true.
 */
function printManualSteps(out: Print, project: string | undefined, harnessAlias: string, destRel: string): void {
  out('')
  out('Next steps:')
  out('  1. Create or choose the GitHub repository this implementation will live in, and push this commit there.')
  out('  2. On that repository, set the BFFLESS_API_KEY secret and the BFFLESS_URL variable (Settings -> Secrets and variables -> Actions).')
  out(
    `  3. Make sure that repository has contributor role on the "${project ?? '<project>'}" BFFless project — ` +
      `the target of harness alias "${harnessAlias}".`,
  )
  out('  4. If that BFFless instance does not already have a Workflow harness installed, install it from the catalog (Admin -> Apps) before the first deploy.')
  if (destRel !== '.') {
    out(
      `  5. Add "${destRel}" to this repo's pnpm-workspace.yaml packages list (create the file if it doesn't have one yet), ` +
        `then run \`pnpm install\` to update the lockfile — the generated workflow builds with \`pnpm --filter ./${destRel} run build\`, ` +
        'which only resolves once the workspace covers it.',
    )
  }
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
    const skippedGenerated = generatedFiles.filter((g) => existsSync(g.file)).map((g) => g.relFile)
    const sourceDescr = packagePath === '.' ? parsed.from : `${parsed.from}/${packagePath}`

    // `destDir` occupied by a plain file is its own, unconditional failure —
    // not a --skip-existing-able collision with a specific package path, but
    // a structural mismatch `mkdirSync` would otherwise throw `ENOTDIR` on.
    if (existsSync(destDir) && !statSync(destDir).isDirectory()) {
      err(`workflow: ${destRel}/ exists and is not a directory`)
      return 2
    }

    // C1: the rename pass must never run over `destDir` itself — for
    // `--dest .` that IS the host repo, and rewriting every file in it that
    // happens to contain the old alias (e.g. a common word like "hello")
    // would silently corrupt files the copy never touched. So the package is
    // always staged into a disposable temp dir first, renamed there (that
    // also gives real-run and dry-run one shared code path for computing the
    // rename report — previously duplicated), and only the staged, already
    // post-rename result ever gets copied into `destDir`.
    const stage = mkdtempSync(join(tmpdir(), 'workflow-init-stage-'))
    try {
      cpSync(packageDir, stage, { recursive: true, filter: (p) => basename(p) !== '.git' })
      const report = renamePass(stage, identity.alias, parsed.alias, { dryRun: false })
      writeIdentity(stage, { alias: parsed.alias, harness: parsed.harnessAlias })
      const stagedFiles = listCopyableFiles(stage)

      // A preflight, not a write: catches a populated destination — most
      // pointedly a populated `--dest .` — before anything is touched. Real
      // run and dry run alike, so `--dry-run` previews the failure exactly as
      // the real run would hit it. Checked against the post-rename staged
      // file list, not the raw source listing (see findDestinationConflicts).
      const conflicts = findDestinationConflicts(destDir, stagedFiles)
      if (conflicts.length > 0 && !parsed.skipExisting) {
        const tag = parsed.dryRun ? '(dry run) ' : ''
        err(
          `workflow: ${tag}${destRel}/ already has ${conflicts.length} path(s) init would overwrite — ` +
            'refusing to clobber the destination (pass --skip-existing to keep the host\'s versions and proceed):',
        )
        for (const c of conflicts) err(`  ${c}`)
        return 2
      }

      // #559: --skip-existing must not "merge" past a load-bearing file.
      // Skipping the package's own package.json/tsconfig.json/lockfile/
      // vite.config.* orphans the copy (or breaks the host's build) while
      // exiting 0 — an unrecoverable state presented as success. Refuse
      // instead (exit 2, nothing written), pointing at --dest <subdir>,
      // where nothing collides at all. Non-tier-1 collisions keep the skip
      // behaviour below.
      if (parsed.skipExisting) {
        const tier1 = conflicts.filter(isTier1)
        if (tier1.length > 0) {
          const tag = parsed.dryRun ? '(dry run) ' : ''
          err(
            `workflow: ${tag}--skip-existing would keep the host's version of ${tier1.length} load-bearing file(s) the copied ` +
              'implementation cannot install or build without — refusing (use --dest <subdir> to land it in its own directory instead):',
          )
          for (const c of tier1) err(`  ${c}`)
          return 2
        }
      }

      // I5: with --skip-existing, colliding paths are left exactly as the
      // host has them — not copied at all — rather than refusing outright.
      const skippedExisting = parsed.skipExisting ? conflicts : []
      const skipSet = new Set(skippedExisting)
      const copiedFiles = stagedFiles.filter((f) => !skipSet.has(f))

      // #559: computed before anything is written — after the copy, every
      // directory exists and the distinction this reports would be gone.
      const dirMerges = findDirectoryMerges(destDir, copiedFiles)

      if (parsed.dryRun) {
        const tag = '(dry run) '
        out(`${tag}copy ${sourceDescr} -> ${destRel}/ (${copiedFiles.length} file(s))`)
        for (const f of copiedFiles) out(`${tag}  ${f}`)
        printRenameReport(out, tag, report, identity.alias, parsed.alias)
        printSkipped(out, tag, skippedExisting)
        printMerged(out, tag, dirMerges)
        printGenerated(out, tag, generatedFiles, skippedGenerated)
        printManualSteps(out, parsed.project, parsed.harnessAlias, destRel)
        out(`${tag}would init ${parsed.alias} in ${destRel}/`)
        return 0
      }

      try {
        mkdirSync(destDir, { recursive: true })
        cpSync(stage, destDir, {
          recursive: true,
          filter: (src) => {
            const rel = toPosix(relative(stage, src))
            return rel === '' || !skipSet.has(rel)
          },
        })
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

      out(`copy ${sourceDescr} -> ${destRel}/ (${copiedFiles.length} file(s))`)
      for (const f of copiedFiles) out(`  ${f}`)
      printRenameReport(out, '', report, identity.alias, parsed.alias)
      printSkipped(out, '', skippedExisting)
      printMerged(out, '', dirMerges)
      printGenerated(out, '', generatedFiles, skippedGenerated)
      printManualSteps(out, parsed.project, parsed.harnessAlias, destRel)
      out(`✔ initialized ${parsed.alias} in ${destRel}/`)
      return 0
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  } finally {
    source.cleanup()
  }
}
