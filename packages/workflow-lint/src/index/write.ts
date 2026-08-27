/**
 * The fs half of `workflow index`: read an implementation's workflow YAMLs,
 * see which islands and scripts have already been staged, and — if
 * `buildIndex` is happy — write the bundle's `.bffless/workflows/` directory
 * and a landing page.
 *
 * Everything impure lives here: the reads, the copies, the `generatedAt`
 * timestamp and the defaults for `--version` / `--commit`. `./index.ts` stays a
 * function of its arguments.
 *
 * This is the generalisation of `apps/workflow/scripts/stage-hello.mjs`, so a
 * separate implementation repo can run the same publish step over npx without
 * copying that script. The `index.json` shape is unchanged from it — the
 * harness UI reads those exact keys.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { RuleSetContext } from '../rules/match.js'
import { buildIndex, type BuildIndexResult, type IndexFinding, type IndexJson } from './index.js'

export type { IndexFinding, IndexJson } from './index.js'

/** `index.json` as it lands on disk. */
export interface WrittenIndex extends IndexJson {
  generatedAt: string
}

export interface WriteIndexOptions {
  /** The directory holding the implementation's `*.workflow.yaml` files. */
  workflowsDir: string
  /** The bundle root — islands and scripts are read from it, the index written into it. */
  out: string
  impl: string
  name: string
  description?: string
  version: string
  commit: string
  rules: RuleSetContext
}

export type WriteIndexResult =
  | { ok: true; index: WrittenIndex; indexFile: string }
  | { ok: false; findings: IndexFinding[] }

/** Top-level YAML files, in listing order — the order the harness shows them in. */
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

/**
 * The bundle alias serves a bundle, not a site — but a member who follows the
 * implementation link deserves a sentence rather than a 404. The harness's own
 * host is this alias with `<impl>.` swapped for `workflow.`, which only the
 * browser knows, so the link is computed there.
 */
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

/**
 * `--version` default: the nearest `package.json` at or above the workflows
 * directory — an implementation repo's own version. `0.0.0` when there is none,
 * so a bundle staged from a bare directory still has an honest number.
 */
export function defaultVersion(workflowsDir: string): string {
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

/**
 * `--commit` default: CI's `GITHUB_SHA`. Deliberately no `git` fallback — this
 * package runs over `npx` in someone else's repo, and shelling out there is
 * neither reliable nor its business. `unknown` is the honest answer.
 */
export function defaultCommit(): string {
  return process.env.GITHUB_SHA?.slice(0, 7) ?? 'unknown'
}

export function writeIndex(opts: WriteIndexOptions): WriteIndexResult {
  const files = workflowFiles(opts.workflowsDir)
  const built: BuildIndexResult = buildIndex({
    impl: opts.impl,
    name: opts.name,
    description: opts.description,
    version: opts.version,
    commit: opts.commit,
    workflows: files.map((file) => ({ file, yaml: readFileSync(join(opts.workflowsDir, file), 'utf8') })),
    islands: bundleFiles(opts.out, 'islands', /\.html$/),
    scripts: bundleFiles(opts.out, 'scripts', /\.m?js$/),
    rules: opts.rules,
  })
  // Nothing is written for a failing lint: a half-staged bundle whose index
  // predates the failure is worse than no bundle at all (06).
  if (!built.ok) return built

  // The only directory this command owns is cleared before it is written, so a
  // renamed or deleted YAML never lingers in a re-used local out dir. Never
  // `<out>` itself, which holds the islands and scripts someone else staged.
  const workflowDir = join(opts.out, '.bffless', 'workflows')
  rmSync(workflowDir, { recursive: true, force: true })
  mkdirSync(workflowDir, { recursive: true })
  for (const file of files) copyFileSync(join(opts.workflowsDir, file), join(workflowDir, file))

  const { workflows, islands, scripts, ...head } = built.index
  // Key order is the one stage-hello.mjs writes, and index.json is read by
  // people as often as by the harness.
  const index: WrittenIndex = { ...head, generatedAt: new Date().toISOString(), workflows, islands, scripts }

  const indexFile = join(workflowDir, 'index.json')
  writeFileSync(indexFile, JSON.stringify(index, null, 2))
  writeFileSync(join(opts.out, 'index.html'), landingPage(opts.impl))

  return { ok: true, index, indexFile }
}
