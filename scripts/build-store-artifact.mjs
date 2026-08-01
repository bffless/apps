#!/usr/bin/env node
// Builds the composite apps.bffless.dev artifact: store site pages at the root,
// registry.json, and assets/<app>/** (each published app's catalog content). Published
// by app-bundles.yml (after an app release) and deploy-store.yml (on store/metadata
// changes) to the app-registry alias — one artifact, so the site, registry, and assets
// can never be deployed out of sync (deployments merge per commit SHA, so two
// independent workflows cannot co-write one alias).
//
// CLI: node scripts/build-store-artifact.mjs [--sidecars dist-bundles] [--out store-dist] [--stage-only]
//   --stage-only: build registry + stage store/public/assets, skip the site build
//                 (local dev helper: pnpm store:assets)
// Env: GITHUB_REPOSITORY (required), ASSET_BASE_URL (optional, see build-registry.mjs).

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildRegistry } from './build-registry.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i === -1 ? fallback : args[i + 1]
}
const sidecarsDir = resolve(repoRoot, opt('--sidecars', 'dist-bundles'))
const outDir = resolve(repoRoot, opt('--out', 'store-dist'))
const stageOnly = args.includes('--stage-only')

function fail(message) {
  console.error(`build-store-artifact: ${message}`)
  process.exit(1)
}

const repo = process.env.GITHUB_REPOSITORY
if (!repo) fail('GITHUB_REPOSITORY env var is required')

// 1. Registry (omission warnings are emitted by the shared builder's CLI path; here we
// re-emit them ourselves — ::warning annotation plus GITHUB_STEP_SUMMARY line — so both
// entry points behave identically).
const { registry, omitted } = buildRegistry({
  appsDir: join(repoRoot, 'apps'),
  sidecarsDir,
  assetBaseUrl: process.env.ASSET_BASE_URL || 'https://apps.bffless.dev',
  repo,
})
for (const app of omitted) {
  console.log(
    `::warning title=app-catalog registry::apps/${app.id}/bffless-app.json declares v${app.version} but no published release (tag ${app.id}-v${app.version}) exists yet — omitted from registry.json`,
  )
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `⚠️ omitted from registry.json: ${app.id} (no published release)\n`)
  }
}
const registryJson = JSON.stringify(registry, null, 2) + '\n'

// 2. Stage assets into store/public/ so the Astro build emits them with the site.
const publicAssets = join(repoRoot, 'store', 'public', 'assets')
rmSync(publicAssets, { recursive: true, force: true })
for (const entry of registry.apps) {
  const catalogDir = join(repoRoot, 'apps', entry.id, 'catalog')
  if (!existsSync(catalogDir)) continue // warned about by the conventions check; tolerated here
  const dest = join(publicAssets, entry.id)
  mkdirSync(dest, { recursive: true })
  for (const name of ['thumbnail.png', 'icon.png']) {
    if (existsSync(join(catalogDir, name))) cpSync(join(catalogDir, name), join(dest, name))
  }
  if (existsSync(join(catalogDir, 'screenshots'))) {
    cpSync(join(catalogDir, 'screenshots'), join(dest, 'screenshots'), { recursive: true })
  }
}

// Also write the registry where dev/build can read it.
const tmpDir = join(repoRoot, '.tmp-store')
mkdirSync(tmpDir, { recursive: true })
const registryFile = join(tmpDir, 'registry.json')
writeFileSync(registryFile, registryJson)

if (stageOnly) {
  console.log(`Staged assets + ${registryFile} (run: REGISTRY_FILE=${registryFile} pnpm store:dev)`)
  process.exit(0)
}

// 3. Build the site against the freshly built registry.
const build = spawnSync('pnpm', ['--filter', 'store', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, REGISTRY_FILE: registryFile },
})
if (build.status !== 0) fail(`store build failed (exit ${build.status})`)

// 4. Assemble store-dist: site + registry.json at the root, plus a transition copy at
// registry-staging/registry.json — the live domain mapping still uses path /registry-staging
// until the rollout step flips it to /, and CE's registry URL must never 404 in between.
// Remove the transition copy (and this comment) once the domain path is /.
rmSync(outDir, { recursive: true, force: true })
cpSync(join(repoRoot, 'store', 'dist'), outDir, { recursive: true })
writeFileSync(join(outDir, 'registry.json'), registryJson)
mkdirSync(join(outDir, 'registry-staging'), { recursive: true })
writeFileSync(join(outDir, 'registry-staging', 'registry.json'), registryJson)

// 5. Smoke assertions — fail loudly rather than deploy a structurally broken artifact.
const mustExist = ['index.html', '404.html', 'registry.json', 'registry-staging/registry.json']
for (const entry of registry.apps) {
  mustExist.push(join('apps', entry.id, 'index.html'))
  mustExist.push(join('assets', entry.id, 'thumbnail.png'))
}
const missing = mustExist.filter((rel) => !existsSync(join(outDir, rel)))
if (missing.length > 0) fail(`artifact is missing: ${missing.join(', ')}`)

const published = JSON.parse(readFileSync(join(outDir, 'registry.json'), 'utf8'))
if (published.schemaVersion !== 1) fail('registry.json schemaVersion must be 1')

console.log(`\nBuilt ${outDir}: ${registry.apps.length} app(s), ${omitted.length} omitted.`)
