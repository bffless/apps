#!/usr/bin/env node
// Stage the `hello` implementation: clone `bffless/workflow-hello` at the
// commit pinned by `hello.ref`, build it (its own `pnpm build`), and land the
// result — `.bffless/workflows/{*.yaml,index.json}`, `islands/*.html`,
// `scripts/*.js`, `index.html` — in `hello-dist/`. `hello` moved to its own
// repo (M3 Task 7, Decision 5 "one source"): this monorepo no longer owns the
// implementation's sources, only the pin.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const ref = readFileSync(join(appDir, 'hello.ref'), 'utf8').trim()
const src = join(appDir, 'hello-src')
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(appDir, 'hello-dist')
const repo = process.env.WORKFLOW_HELLO_REPO ?? 'https://github.com/bffless/workflow-hello.git'

// Re-clone whenever the checkout is missing or sitting on a different commit
// than `hello.ref` — a stale local `hello-src/` from an earlier pin must never
// silently stage the wrong bundle.
if (!existsSync(src) || execFileSync('git', ['-C', src, 'rev-parse', 'HEAD']).toString().trim() !== ref) {
  rmSync(src, { recursive: true, force: true })
  // A `file://` remote (WORKFLOW_HELLO_REPO, for iterating on both repos at
  // once) is a plain local path as far as git clone is concerned — a shallow
  // clone works the same way it does over the network.
  execFileSync('git', ['clone', '--quiet', repo, src], { stdio: 'inherit' })
  execFileSync('git', ['-C', src, 'checkout', '--quiet', ref], { stdio: 'inherit' })
}

// `--ignore-workspace`: `hello-src` is cloned *inside* this monorepo's own
// pnpm workspace, so a plain `pnpm install` here would walk up, find the
// monorepo's `pnpm-workspace.yaml`, and install workflow-hello as a member of
// it instead of as its own standalone project — no local `node_modules/.bin`,
// none of its own deps resolved.
const installArgs = ['install', '--ignore-workspace']
if (existsSync(join(src, 'pnpm-lock.yaml'))) installArgs.push('--frozen-lockfile')
execFileSync('pnpm', installArgs, { cwd: src, stdio: 'inherit' })
execFileSync('pnpm', ['build'], { cwd: src, stdio: 'inherit' })

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(src, 'dist'), out, { recursive: true })

console.log('staged', join(out, '.bffless/workflows/index.json'), 'from', repo, '@', ref)
