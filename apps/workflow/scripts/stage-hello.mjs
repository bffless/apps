#!/usr/bin/env node
// Stage the workflow-hello bundle (06): the workflow YAMLs, the single-file
// islands, any scripts, and the generated index.json that lists all three.
//
// This is what a real implementation's CI runs, and it is deliberately strict:
// a workflow that fails lint is never published (06), because the harness would
// then discover a workflow it cannot run.
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, execFileSync } from 'node:child_process'
import { lintSource, loadDefinition } from '@bffless/workflow-lint'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const examples = join(appDir, 'docs/spec/examples')

/**
 * The app's own binaries, not `npx`: `npx` will happily reach the network for a
 * package this workspace already pins, and a stage that silently installs a
 * different `vite` is not a reproducible publish.
 */
const bin = (name) => join(appDir, 'node_modules', '.bin', name)
const outIdx = process.argv.indexOf('--out')
const out = outIdx > -1 ? process.argv[outIdx + 1] : join(appDir, 'hello-dist')

/** The workflows this implementation publishes, in listing order (Decision 3). */
const WORKFLOWS = ['hello.workflow.yaml', 'interactive.workflow.yaml']

/**
 * The islands, in listing order. Each is a directory under `hello/islands/`
 * holding `index.html` + `main.ts`; the build turns each into one
 * self-contained `islands/<name>.html` (04).
 */
const ISLANDS = ['pick-line', 'line-viewer']

// ---------------------------------------------------------------------------
// Workflows — lint, then copy
// ---------------------------------------------------------------------------

const workflows = WORKFLOWS.map((file) => {
  const source = join(examples, file)
  const yaml = readFileSync(source, 'utf8')

  const { findings } = lintSource(yaml, { file })
  if (findings.some((f) => f.severity === 'error' || f.severity === 'warning')) {
    console.error(`${file} fails lint — a failing lint fails the publish (06):`, findings)
    process.exit(1)
  }

  const { def } = loadDefinition(yaml)
  return {
    source,
    file,
    name: def.name,
    description: def.raw.description ?? '',
    inputs: Object.keys(def.inputs).length,
    jobs: Object.keys(def.jobs).length,
    // 07: a workflow is headless-safe when no interactive step would fail fast.
    headlessSafe: !findings.some((f) => f.rule === 'interactive-headless'),
  }
})

// Every directory this script owns is cleared before it is written, so a
// renamed or deleted YAML / script / island never lingers in a re-used local
// `hello-dist` (CI is always fresh). Only these three — never `<out>` itself,
// which `--out` lets the caller point anywhere.
const workflowDir = join(out, '.bffless', 'workflows')
const islandDir = join(out, 'islands')
const scriptOut = join(out, 'scripts')
for (const dir of [workflowDir, islandDir, scriptOut]) rmSync(dir, { recursive: true, force: true })

mkdirSync(workflowDir, { recursive: true })
for (const workflow of workflows) copyFileSync(workflow.source, join(workflowDir, workflow.file))

// ---------------------------------------------------------------------------
// Islands — one single-file Vite build each (see hello/vite.islands.config.ts)
// ---------------------------------------------------------------------------

mkdirSync(islandDir, { recursive: true })

// The islands are type-checked *here*, by the thing that publishes them, and
// deliberately **not** by the harness's `tsc -b`: `pnpm --filter workflow build`
// and `test:run` must never fail because a bundle file has a type error, so
// `tsconfig.islands.json` is not referenced from `tsconfig.json` and the suite
// that runs this script is its own `test:stage`. An island type error still
// fails a CI job at the `stage` step — before anything is uploaded — which is
// the right place: a bundle that does not build is not published (06).
execFileSync(bin('tsc'), ['-p', 'tsconfig.islands.json'], { cwd: appDir, stdio: 'inherit' })

for (const island of ISLANDS) {
  execFileSync(bin('vite'), ['build', '-c', 'hello/vite.islands.config.ts'], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, WORKFLOW_ISLAND: island, WORKFLOW_ISLANDS_OUT: islandDir },
  })
}
const islands = ISLANDS.map((island) => `islands/${island}.html`)

// ---------------------------------------------------------------------------
// Scripts — copied verbatim; the Worker fetches them as modules (Decision 2)
// ---------------------------------------------------------------------------

const scriptSrc = join(appDir, 'hello', 'scripts')

// Type-checked *as JavaScript* here, by the thing that publishes them
// (`tsconfig.scripts.json`: `allowJs` + `checkJs` against each module's JSDoc
// `@type` import of `@bffless/workflow-script`), for the same reason the
// islands are: a broken script must fail the bundle stage, never the harness
// build. Before apps#375 nothing checked these at all.
execFileSync(bin('tsc'), ['-p', 'tsconfig.scripts.json'], { cwd: appDir, stdio: 'inherit' })
// Phase 2 (Decision 13) adds the first one; until then the directory is absent
// and `scripts: []` is the honest answer, not a missing-file crash.
const scriptFiles = existsSync(scriptSrc)
  ? readdirSync(scriptSrc, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.m?js$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  : []

if (scriptFiles.length > 0) {
  mkdirSync(scriptOut, { recursive: true })
  for (const file of scriptFiles) copyFileSync(join(scriptSrc, file), join(scriptOut, file))
}
const scripts = scriptFiles.map((file) => `scripts/${file}`)

// ---------------------------------------------------------------------------
// index.json (06) + a landing page, so the bundle alias is not a bare 404
// ---------------------------------------------------------------------------

const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version
const commit = process.env.GITHUB_SHA?.slice(0, 7) ?? execSync('git rev-parse --short HEAD').toString().trim()

writeFileSync(join(workflowDir, 'index.json'), JSON.stringify({
  spec: 1, impl: 'hello', name: 'Hello',
  // Shown on the Implementations screen — keep it true to what the bundle holds.
  description: 'M2 test implementation: hello (echo, slow job + poll, fail-on-purpose) and an interactive island round-trip; two islands (pick-line, line-viewer); analyze.',
  version, commit, generatedAt: new Date().toISOString(),
  workflows: workflows.map(({ file, name, description, inputs, jobs, headlessSafe }) => ({
    file, name, description, inputs, jobs, headlessSafe,
  })),
  islands, scripts,
}, null, 2))

// The hello alias serves a bundle, not a site — but a member who follows the
// implementation link deserves a sentence rather than a 404 (M1 minor). The
// harness's own host is this alias with `hello.` swapped for `workflow.`, which
// only the browser knows, so the link is computed there.
writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>workflow-hello</title></head>
<body style="font:15px/1.6 system-ui,sans-serif;margin:3rem auto;max-width:34rem;padding:0 1rem">
<p>workflow-hello — a bundle-only alias; open <a id="harness" href="/.bffless/workflows/index.json">the harness</a>.</p>
<script>
  var host = location.hostname.replace(/^hello\\./, 'workflow.')
  if (host !== location.hostname) document.getElementById('harness').href = location.protocol + '//' + host
</script>
</body></html>
`)

console.log('staged', join(workflowDir, 'index.json'))
