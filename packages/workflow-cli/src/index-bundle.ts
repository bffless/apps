/**
 * The pure-ish half of `workflow index` — the bundle-writing machinery
 * `runIndex` (./cli.ts) and `runPublish` (./verbs/publish.ts, Task 6) both
 * need: `buildIndex` (the actual lint) plus the filesystem work of turning a
 * clean result into a bundle (`<out>/.bffless/workflows/index.json` +
 * `<out>/index.html`).
 *
 * Split out of cli.ts (where it started, Task 1) once `publish` needed the
 * exact same "index the workflows -> write the bundle" step as its first
 * move (Decision 8: docs/superpowers/plans/2026-08-31-workflow-cli-authoring.md:24)
 * — importing it from cli.ts directly would have made cli.ts and
 * verbs/publish.ts import each other (cli.ts already imports
 * parsePublish/runPublish), so this lives in its own module instead.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { buildIndex, type IndexFinding, type RuleSetContext } from '@bffless/workflow-lint'

/** Everything `writeIndexBundle` needs off an `index`/`publish` args object — both satisfy this structurally. */
export interface BundleArgs {
  workflowsDir: string
  out: string
  impl: string
  name: string
  description?: string
  version?: string
  commit?: string
}

/** The `buildIndex` result once a failing lint has already returned. */
export type WriteResult = { ok: true; workflowCount: number; indexFile: string } | { ok: false; findings: IndexFinding[] }

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

/**
 * Everything that touches disk beyond the up-front directory/rules checks:
 * reading the workflow YAMLs, running `buildIndex`, and — only on success —
 * writing the bundle. Callers (`runIndex`/`runPublish`) wrap exactly this in
 * a try/catch: a permission error, a full disk, or a file deleted mid-run
 * must surface as `workflow: <message>` on stderr with exit 2, never an
 * uncaught exception.
 */
export function writeIndexBundle(parsed: BundleArgs, rules: RuleSetContext): WriteResult {
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
