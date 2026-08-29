#!/usr/bin/env node
// Stage the `workflow-studio` bundle: type-check, build each island as one self-contained
// HTML file, build each `script` step as one self-contained ES module, then let
// `@bffless/workflow-lint`'s `workflow index` verb lint `.bffless/workflows/` and write the
// bundle's index.json + a landing page.
//
// Modeled on `bffless/workflow-hello`'s `scripts/build.mjs` (ref 195b5a2) — same shape, same
// reasons — with two differences this app forces:
//   * hello COPIES its scripts verbatim (they are hand-written `.js`); Studio's five are
//     TypeScript that import Studio's pure libs, so each is a Vite library build
//     (`vite.scripts.config.ts`, one entry per build) and the entries are an explicit list
//     rather than a directory scan: `scripts/` also holds this file, `scripts/lib/` support
//     code and `scripts/*.test.ts` suites, none of which is a step module.
//   * the type-check is this app's three `tsc -p` projects (islands / scripts / node
//     tooling), not hello's single `tsconfig.json`.
//
// Deliberately plain JS, outside every TS project (as hello's build.mjs is): it is the thing
// that RUNS `tsc`, so it cannot be an input to it. Its behaviour is covered by
// `src/stage.test.ts`, which runs it for real.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * This app's own binaries, never `npx` (R23 / R123): a reproducible build never silently
 * reaches the network for a tool the workspace already pins. `vite` and `tsc` are this app's
 * devDependencies and ship built, so their `node_modules/.bin` shims always exist.
 *
 * `workflow` (`@bffless/workflow-lint`) is NOT reached this way — see `workflowCli()`.
 */
const bin = (name) => join(appDir, 'node_modules', '.bin', name)

/**
 * The path to `@bffless/workflow-lint`'s CLI, resolved through the module system rather than
 * through `node_modules/.bin/workflow`.
 *
 * That shim does not exist on a fresh install. The package is a workspace sibling whose `bin`
 * points at `dist/cli.js`, which is BUILT — by `pnpm --filter @bffless/workflow-lint build`,
 * the step that runs right after `pnpm install` in CI. pnpm skips creating a bin shim whose
 * target is missing at install time, and never revisits it, so CI had no
 * `.bin/workflow` at all (`ENOENT spawnSync`) while local checkouts had one only because some
 * earlier install happened to follow a build. Resolving the package instead is immune to that
 * ordering.
 *
 * The package's `exports` map does not expose `./package.json`, so resolve its main entry and
 * walk up to the manifest beside it; the manifest's own `bin.workflow` is then the truth about
 * where the CLI lives — the same value the shim would have pointed at.
 */
function workflowCli() {
  const require = createRequire(import.meta.url)

  let entry
  try {
    entry = require.resolve('@bffless/workflow-lint')
  } catch (cause) {
    // Its main entry and its CLI are emitted by the same build, so a resolve failure here
    // means exactly one thing.
    throw new Error(
      'stage.mjs: @bffless/workflow-lint is not built — run `pnpm --filter @bffless/workflow-lint build` first.',
      { cause },
    )
  }

  let dir = dirname(entry)
  let manifestPath = null
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === '@bffless/workflow-lint') {
      manifestPath = candidate
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (!manifestPath) throw new Error(`stage.mjs: no @bffless/workflow-lint package.json above ${entry}`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.workflow
  if (!relative) throw new Error(`stage.mjs: ${manifestPath} declares no \`workflow\` bin`)

  const cli = join(dirname(manifestPath), relative)
  if (!existsSync(cli)) {
    throw new Error(
      `stage.mjs: @bffless/workflow-lint is not built (${cli} is missing) — ` +
        'run `pnpm --filter @bffless/workflow-lint build` first.',
    )
  }
  return cli
}

/** The three projects `package.json`'s `typecheck` runs — kept in step with it. */
const TSCONFIGS = ['tsconfig.islands.json', 'tsconfig.scripts.json', 'tsconfig.node.json']

/**
 * The five `script` step modules `studio.workflow.yaml` names (`src: scripts/<name>.js`),
 * sorted. An explicit list, not a directory scan: `scripts/` also holds this stager,
 * `scripts/lib/` and the `*.test.ts` suites.
 */
const SCRIPTS = ['blog-bundle', 'final-script', 'frame-times', 'scene-inputs', 'sheet-plan']

/**
 * One line, shown on the harness's Implementations screen. Duplicated by hand in
 * `.github/workflows/deploy-workflow-studio.yml`'s `description:` input — nothing enforces
 * that the two match, and THAT one is the value that ships: `bffless/publish-workflow@v1`
 * re-runs `workflow index` over the staged bundle and overwrites what this writes. Change
 * both together.
 */
const DESCRIPTION =
  'The reference port of Studio: long screen recordings become a cut-first short in your own recorded voice, plus a companion blog post and a cover image.'

/** Everything this stager writes under the bundle root — and so everything it may delete. */
const BUNDLE_ENTRIES = ['.bffless', 'islands', 'scripts', 'index.html']

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')

/**
 * A flag's value, validated: a flag with no following value, or one whose "value" is itself
 * another flag, is a usage error — never silently `undefined` or the next flag's name.
 */
function flagValue(name, fallback) {
  const idx = args.indexOf(name)
  if (idx === -1) return fallback
  const value = args[idx + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`stage.mjs: ${name} needs a value`)
  }
  return value
}

const explicitOut = flagValue('--out', null)
// A preview build (a PR alias, e.g. `workflow-studio-pr-7`) stages the same source under a
// different alias/display name — the published `impl` must say which one, since the harness
// reads it back to know what it just deployed.
const impl = flagValue('--impl', 'workflow-studio')
const name = flagValue('--name', 'Studio')

// `--check` is a "does it build" gate and nothing more: the whole build runs into a throwaway
// temp dir, which is discarded when it's done.
const out = checkOnly
  ? mkdtempSync(join(tmpdir(), 'workflow-studio-stage-'))
  : (explicitOut ?? join(appDir, 'dist'))

/**
 * Refuse to clear a directory that isn't a bundle root. `--out` is a path this stager will
 * delete from, and the default is `dist/` — but nothing stops someone pointing it at a source
 * tree or a home directory, so anything holding an entry this stager never writes is left
 * completely untouched (checked BEFORE the type-check, so a bad `--out` fails in
 * milliseconds rather than after a minute of building).
 */
function assertClearable(dir) {
  if (!existsSync(dir)) return
  const strays = readdirSync(dir).filter((entry) => !BUNDLE_ENTRIES.includes(entry))
  if (strays.length > 0) {
    throw new Error(
      `stage.mjs: refusing to stage into ${dir} — it holds ${strays.join(', ')}, which no build wrote. ` +
        `Point --out at a bundle root (or an empty/absent directory).`,
    )
  }
}

try {
  assertClearable(out)

  // Type-checked *before* anything under `out` is touched: a type error in an island, a
  // script or the Vite configs leaves whatever bundle was staged last time intact, rather
  // than a half-wiped `dist/`.
  for (const project of TSCONFIGS) {
    execFileSync(bin('tsc'), ['-p', project], { cwd: appDir, stdio: 'inherit' })
  }

  for (const entry of BUNDLE_ENTRIES) rmSync(join(out, entry), { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  // ---------------------------------------------------------------------
  // Islands — one single-file Vite build each (see vite.islands.config.ts). Read from the
  // directory rather than hard-coded, so a second island needs no change here; an island is
  // a directory with its own `index.html` (the Vite root), which is also what excludes
  // `islands/test/` (shared test helpers, not an island).
  // ---------------------------------------------------------------------
  const islandsSrcDir = join(appDir, 'islands')
  const ISLANDS = readdirSync(islandsSrcDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(islandsSrcDir, entry.name, 'index.html')))
    .map((entry) => entry.name)
    .sort()

  const islandOut = join(out, 'islands')
  mkdirSync(islandOut, { recursive: true })
  for (const island of ISLANDS) {
    execFileSync(bin('vite'), ['build', '-c', 'vite.islands.config.ts'], {
      cwd: appDir,
      stdio: 'inherit',
      env: { ...process.env, WORKFLOW_ISLAND: island, WORKFLOW_ISLANDS_OUT: islandOut },
    })
  }

  // ---------------------------------------------------------------------
  // Scripts — one library build each (see vite.scripts.config.ts), then checked: a `script`
  // step's module is fetched as text and run in a Worker spawned from a `data:` URL (spec
  // 03/09), so a surviving `import` would resolve against an opaque origin and fail at run
  // time, and a sibling chunk would never be fetched at all. `scripts/build.test.ts` asserts
  // the same thing over the staged `dist/`; asserting it here too means a broken bundle
  // can never be published, whatever order CI ran its steps in.
  // ---------------------------------------------------------------------
  const scriptOut = join(out, 'scripts')
  mkdirSync(scriptOut, { recursive: true })
  for (const script of SCRIPTS) {
    execFileSync(bin('vite'), ['build', '-c', 'vite.scripts.config.ts'], {
      cwd: appDir,
      stdio: 'inherit',
      env: { ...process.env, WORKFLOW_SCRIPT: `scripts/${script}.ts`, WORKFLOW_SCRIPTS_OUT: scriptOut },
    })

    const file = join(scriptOut, `${script}.js`)
    if (!existsSync(file)) throw new Error(`stage.mjs: ${script} built no ${file}`)
    const code = readFileSync(file, 'utf8')
    if (/(^|[\s;}])import\s*[({'"*]/.test(code) || /(^|[\s;}])from\s*['"]/.test(code)) {
      throw new Error(`stage.mjs: ${file} still has an import — it would fail in the Worker`)
    }
  }

  // ---------------------------------------------------------------------
  // Skills — `.bffless/skills/<name>/SKILL.md`, copied verbatim into the bundle so the
  // rule set's `ai_handler` steps can `load_skill` them (#430). CE lists a step's skills
  // from a DEPLOYMENT (`<owner>/<repo>/commits/<sha>/<skills.path>/`), and the rules
  // name this alias (`skills.alias: workflow-studio`) and this exact bundle path
  // (`skills.path: apps/workflow-studio/dist/.bffless/skills` — the deploy's `path`
  // input plus the directory written here), so a publish IS the skills deploy. Nested
  // `.bffless/` survives CE's zip ingestion (the one dot-directory it keeps at any
  // depth — `.bffless/workflows/index.json` beside it already relies on that), unlike
  // apps/studio's `dist/bffless/skills`, which predates that rule. The source directory
  // is a copy of Studio's; `src/skills-drift.test.ts` fails when the two diverge.
  // ---------------------------------------------------------------------
  const skillsSrc = join(appDir, '.bffless', 'skills')
  if (!existsSync(skillsSrc)) throw new Error(`stage.mjs: no skills directory at ${skillsSrc}`)
  cpSync(skillsSrc, join(out, '.bffless', 'skills'), { recursive: true })

  // ---------------------------------------------------------------------
  // .bffless/workflows/index.json + a landing page — `workflow index` lints every workflow
  // in .bffless/workflows against the real rule set and, only if they all pass, writes the
  // bundle's index.json (which also lists the islands/scripts staged above) and copies the
  // YAMLs verbatim. `bffless/publish-workflow@v1` runs the same verb with the same flags at
  // publish time; running it here is what makes a broken workflow fail in CI instead.
  // ---------------------------------------------------------------------
  execFileSync(
    process.execPath,
    [
      workflowCli(),
      'index',
      '.bffless/workflows',
      '--out',
      out,
      '--impl',
      impl,
      '--name',
      name,
      '--description',
      DESCRIPTION,
      '--rules',
      '.bffless/proxy-rules/workflow-studio',
      '--path-prefix',
      '/api/workflow-studio',
    ],
    { cwd: appDir, stdio: 'inherit' },
  )

  console.log('staged', out)
} finally {
  if (checkOnly) rmSync(out, { recursive: true, force: true })
}
