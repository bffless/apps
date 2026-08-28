#!/usr/bin/env node
// Stage the `hello` implementation: clone `bffless/workflow-hello` at the
// commit pinned by `hello.ref`, build it (its own `pnpm build`), and land the
// result — `.bffless/workflows/{*.yaml,index.json}`, `islands/*.html`,
// `scripts/*.js`, `index.html` — in `hello-dist/`. `hello` moved to its own
// repo (M3 Task 7, Decision 5 "one source"): this monorepo no longer owns the
// implementation's sources, only the pin.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const ref = readFileSync(join(appDir, 'hello.ref'), 'utf8').trim()
const src = join(appDir, 'hello-src')

const outIdx = process.argv.indexOf('--out')
if (outIdx > -1 && process.argv[outIdx + 1] === undefined) {
  console.error('stage-hello: --out needs a value')
  process.exit(1)
}
const out = outIdx > -1 ? process.argv[outIdx + 1] : join(appDir, 'hello-dist')

// Guard against a mistyped --out, checked before anything else runs (a bad
// path should fail fast, not after a clone/install/build): only ever clear a
// directory this script (or an earlier run of it) actually staged. The
// stager's own marker is `.bffless/workflows/index.json` — the last thing a
// successful run writes — not merely a `.bffless/` directory existing, which
// e.g. `apps/workflow` itself also has (that would let `--out apps/workflow`
// silently delete the harness's own source).
if (existsSync(out) && readdirSync(out).length > 0 && !existsSync(join(out, '.bffless', 'workflows', 'index.json'))) {
  console.error(`stage-hello: refusing to clear ${out} — it exists, is non-empty, and has no .bffless/workflows/index.json (looks like the wrong --out)`)
  process.exit(1)
}

const repo = process.env.WORKFLOW_HELLO_REPO ?? 'https://github.com/bffless/workflow-hello.git'

/** `git -C src rev-parse HEAD`, or `undefined` for anything that isn't a clean, checked-out repo at HEAD (missing dir, half-finished clone, corrupt .git). Never throws — the caller treats that the same as "wrong commit": remove and re-clone. */
function headOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return undefined
  }
}

// Re-clone whenever the checkout is missing, sitting on a different commit
// than `hello.ref`, or too broken to even answer `rev-parse HEAD` (a stale
// local `hello-src/` from an earlier pin, or an interrupted clone, must never
// silently stage the wrong bundle — or crash on one that isn't a repo at all).
if (headOf(src) !== ref) {
  rmSync(src, { recursive: true, force: true })
  // A `file://` remote (WORKFLOW_HELLO_REPO, for iterating on both repos at
  // once) clones the same way a real GitHub URL does — `git clone` treats it
  // as just another remote.
  execFileSync('git', ['clone', '--quiet', repo, src], { stdio: 'inherit' })
  execFileSync('git', ['-C', src, 'checkout', '--quiet', ref], { stdio: 'inherit' })
}

// `--ignore-workspace`: `hello-src` is cloned *inside* this monorepo's own
// pnpm workspace, so a plain `pnpm install` here would walk up, find the
// monorepo's `pnpm-workspace.yaml`, and install workflow-hello as a member of
// it instead of as its own standalone project — no local `node_modules/.bin`,
// none of its own deps resolved.
execFileSync('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile'], { cwd: src, stdio: 'inherit' })
execFileSync('pnpm', ['build'], { cwd: src, stdio: 'inherit' })

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(src, 'dist'), out, { recursive: true })

console.log('staged', join(out, '.bffless/workflows/index.json'), 'from', repo, '@', ref)
