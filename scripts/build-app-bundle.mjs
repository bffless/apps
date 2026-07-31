#!/usr/bin/env node
// Builds an app-catalog install bundle for one app: a zip containing the app's
// bffless-app.json manifest, its compiled proxy rule sets (rulesets/*.json, built via
// `bffless rules build`), and its production frontend build (dist/**) — the exact shape
// CE's AppBundleService.loadFromBuffer expects (bffless/ce app-catalog, Task 5/15).
//
// Usage: node scripts/build-app-bundle.mjs <app-id>
// Output: dist-bundles/<app-id>-v<version>.bundle.zip
//         dist-bundles/<app-id>-v<version>.sha256  (sha256sum -c compatible: "<hex>  <filename>")
//
// Steps:
//   1. Read + JSON-validate apps/<app-id>/bffless-app.json (schemaVersion 1, id, version present).
//   2. `pnpm --filter <app-id> build` — produces apps/<app-id>/dist.
//   3. Per install.ruleSets[] entry: `npx --yes bffless@latest rules build <authored-dir> -o <file>`.
//      Do NOT strip any fields from the built envelope ({ version, exportedAt, kind, ruleSet,
//      rules, schemas }) — CE's SyncProxyRuleSetDto whitelists all of them.
//   4. Assemble the zip: bffless-app.json (raw bytes, as authored) + rulesets/*.json + dist/**
//      (entry paths exactly "dist/...", matching manifest.install.deployment.path = "dist").
//   5. sha256 the zip bytes to the sidecar file; print both paths.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { zipSync } from 'fflate'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`build-app-bundle: ${message}`)
  process.exit(1)
}

function run(command, args, opts = {}) {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', ...opts })
  if (result.status !== 0) {
    fail(`command failed (exit ${result.status}): ${command} ${args.join(' ')}`)
  }
}

// Node 20's readdirSync({ recursive: true }) returns entries relative to `dir`, files and
// directories mixed — filter to files only.
function listFilesRecursive(dir) {
  return readdirSync(dir, { recursive: true })
    .map((rel) => rel.toString())
    .filter((rel) => statSync(join(dir, rel)).isFile())
}

function main() {
  const appId = process.argv[2]
  if (!appId) {
    fail('usage: node scripts/build-app-bundle.mjs <app-id>')
  }

  const appDir = join(repoRoot, 'apps', appId)
  if (!existsSync(appDir)) {
    fail(`no such app: apps/${appId}`)
  }

  // Step 1: read + validate the manifest.
  const manifestPath = join(appDir, 'bffless-app.json')
  if (!existsSync(manifestPath)) {
    fail(`missing apps/${appId}/bffless-app.json — this app has no app-catalog manifest`)
  }
  const manifestRaw = readFileSync(manifestPath)
  let manifest
  try {
    manifest = JSON.parse(manifestRaw.toString('utf8'))
  } catch (err) {
    fail(`apps/${appId}/bffless-app.json is not valid JSON: ${err.message}`)
  }
  if (manifest.schemaVersion !== 1) fail(`bffless-app.json: schemaVersion must be 1`)
  if (!manifest.id) fail(`bffless-app.json: id is required`)
  if (!manifest.version) fail(`bffless-app.json: version is required`)
  if (!manifest.install || !Array.isArray(manifest.install.ruleSets) || manifest.install.ruleSets.length === 0) {
    fail(`bffless-app.json: install.ruleSets must be a non-empty array`)
  }
  if (!manifest.install.deployment || !manifest.install.deployment.path) {
    fail(`bffless-app.json: install.deployment.path is required`)
  }

  console.log(`Building bundle for ${manifest.id} v${manifest.version}...`)

  // Step 2: build the frontend.
  run('pnpm', ['--filter', appId, 'build'])

  const distDir = join(appDir, manifest.install.deployment.path)
  if (!existsSync(distDir)) {
    fail(`build did not produce apps/${appId}/${manifest.install.deployment.path}`)
  }

  // Step 3: build each declared rule set from its authored source dir.
  const zipEntries = {}
  for (const ruleSetEntry of manifest.install.ruleSets) {
    const match = /^rulesets\/([a-zA-Z0-9._-]+)\.json$/.exec(ruleSetEntry.file || '')
    if (!match) {
      fail(`bffless-app.json: install.ruleSets[].file "${ruleSetEntry.file}" must match rulesets/<name>.json`)
    }
    const setName = match[1]
    const setDir = join(appDir, '.bffless', 'proxy-rules', setName)
    if (!existsSync(join(setDir, 'ruleset.yaml'))) {
      fail(
        `bffless-app.json declares ${ruleSetEntry.file} but there is no authored set at ` +
          `apps/${appId}/.bffless/proxy-rules/${setName}/ruleset.yaml`,
      )
    }

    const outFile = join(repoRoot, '.tmp-bundle-rulesets', appId, `${setName}.json`)
    mkdirSync(dirname(outFile), { recursive: true })
    run('npx', ['--yes', 'bffless@latest', 'rules', 'build', relative(repoRoot, setDir), '-o', outFile])

    if (!existsSync(outFile)) {
      fail(`rules build did not produce an output file for ${setName}`)
    }
    // Do NOT strip any envelope fields (version/exportedAt/kind) — CE's SyncProxyRuleSetDto
    // whitelists them, and CE's sync resolves schemas by name (the ids are in-payload keys only).
    zipEntries[ruleSetEntry.file] = readFileSync(outFile)
  }

  // Step 4: assemble the zip — manifest + rulesets/*.json + dist/** (paths exactly "dist/...").
  zipEntries['bffless-app.json'] = manifestRaw
  for (const relPath of listFilesRecursive(distDir)) {
    const zipPath = `${manifest.install.deployment.path}/${relPath.split('\\').join('/')}`
    zipEntries[zipPath] = readFileSync(join(distDir, relPath))
  }

  const zipBuffer = Buffer.from(zipSync(zipEntries, { level: 6 }))

  const outDir = join(repoRoot, 'dist-bundles')
  mkdirSync(outDir, { recursive: true })
  const baseName = `${appId}-v${manifest.version}.bundle`
  const zipPath = join(outDir, `${baseName}.zip`)
  writeFileSync(zipPath, zipBuffer)

  // Step 5: sha256 sidecar (sha256sum -c compatible: "<hex>  <filename>").
  const sha256 = createHash('sha256').update(zipBuffer).digest('hex')
  const shaPath = join(outDir, `${baseName}.sha256`)
  writeFileSync(shaPath, `${sha256}  ${baseName}.zip\n`)

  console.log(`\nBuilt bundle:`)
  console.log(`  ${zipPath}`)
  console.log(`  ${shaPath}  (sha256 ${sha256})`)
}

main()
