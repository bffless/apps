#!/usr/bin/env node
// Builds the app-catalog registry.json: one entry per apps/<app>/bffless-app.json whose
// bundle release sidecar (<app>-v<version>.bundle.sha256) is present in --sidecars, folding
// in store metadata from apps/<app>/catalog/ (description.md, thumbnail.png, icon.png,
// screenshots/*). Extracted from .github/workflows/app-bundles.yml so deploy-store.yml can
// reuse it and it can be unit-tested (scripts/build-registry.test.mjs).
//
// CLI: node scripts/build-registry.mjs --out <file> [--apps-dir apps] [--sidecars dist-bundles]
// Env: GITHUB_REPOSITORY (required), ASSET_BASE_URL (default https://apps.bffless.dev),
//      GITHUB_STEP_SUMMARY (optional — omission lines are appended when set).

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

function readCatalog(catalogDir, appAssetBase) {
  if (!existsSync(catalogDir)) return {}
  const out = {}
  const descriptionPath = join(catalogDir, 'description.md')
  if (existsSync(descriptionPath)) out.description = readFileSync(descriptionPath, 'utf8')
  if (existsSync(join(catalogDir, 'thumbnail.png'))) out.thumbnailUrl = `${appAssetBase}/thumbnail.png`
  if (existsSync(join(catalogDir, 'icon.png'))) out.iconUrl = `${appAssetBase}/icon.png`
  const screenshotsDir = join(catalogDir, 'screenshots')
  if (existsSync(screenshotsDir)) {
    const shots = readdirSync(screenshotsDir)
      .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort()
      .map((f) => `${appAssetBase}/screenshots/${f}`)
    if (shots.length > 0) out.screenshots = shots
  }
  return out
}

export function buildRegistry({ appsDir, sidecarsDir, assetBaseUrl, repo }) {
  const apps = readdirSync(appsDir).filter((name) => statSync(join(appsDir, name)).isDirectory())

  // Omission is EXPECTED pre-first-release (a manifest can land before its first tag) — the
  // caller must stay green but surface each omission loudly (::warning + step summary), because
  // a silently smaller registry.json would drop an app with no failure anywhere.
  const omitted = []
  const entries = []

  for (const app of apps) {
    const manifestPath = join(appsDir, app, 'bffless-app.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const baseName = `${app}-v${manifest.version}.bundle`
    const sidecarPath = join(sidecarsDir, `${baseName}.sha256`)
    if (!existsSync(sidecarPath)) {
      omitted.push({ id: app, version: manifest.version })
      continue
    }
    const sha256 = readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0]
    const catalog = readCatalog(join(appsDir, app, 'catalog'), `${assetBaseUrl}/assets/${app}`)
    entries.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      bundleUrl: `https://github.com/${repo}/releases/download/${app}-v${manifest.version}/${baseName}.zip`,
      sha256,
      summary: manifest.summary,
      description: catalog.description,
      category: manifest.category,
      iconUrl: manifest.iconUrl ?? catalog.iconUrl,
      thumbnailUrl: catalog.thumbnailUrl,
      screenshots: catalog.screenshots,
      docsUrl: manifest.docsUrl,
      sourceUrl: manifest.sourceUrl,
      requires: manifest.requires,
    })
  }

  return { registry: { schemaVersion: 1, apps: entries }, omitted }
}

function main() {
  const args = process.argv.slice(2)
  const opt = (flag, fallback) => {
    const i = args.indexOf(flag)
    return i === -1 ? fallback : args[i + 1]
  }
  const outPath = opt('--out')
  if (!outPath) {
    console.error('usage: node scripts/build-registry.mjs --out <file> [--apps-dir apps] [--sidecars dist-bundles]')
    process.exit(1)
  }
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) {
    console.error('build-registry: GITHUB_REPOSITORY env var is required')
    process.exit(1)
  }

  const { registry, omitted } = buildRegistry({
    appsDir: opt('--apps-dir', 'apps'),
    sidecarsDir: opt('--sidecars', 'dist-bundles'),
    assetBaseUrl: process.env.ASSET_BASE_URL || 'https://apps.bffless.dev',
    repo,
  })

  for (const app of omitted) {
    const message = `apps/${app.id}/bffless-app.json declares v${app.version} but no published release (tag ${app.id}-v${app.version}) exists yet — omitted from registry.json`
    console.log(`::warning title=app-catalog registry::${message}`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `⚠️ omitted from registry.json: ${app.id} (no published release)\n`)
    }
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(registry, null, 2) + '\n')
  console.log(JSON.stringify(registry, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
