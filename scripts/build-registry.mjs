#!/usr/bin/env node
// Builds the app-catalog registry.json: one entry per apps/<app>/bffless-app.json whose
// bundle release sidecar (<app>-v<version>.bundle.sha256) is present in --sidecars, folding
// in store metadata from apps/<app>/catalog/ (description.md, thumbnail.png, icon.png,
// screenshots/*) and source provenance from the optional <app>-v<version>.bundle.commit
// sidecar. Extracted from .github/workflows/app-bundles.yml so deploy-store.yml can
// reuse it and it can be unit-tested (scripts/build-registry.test.mjs).
//
// CLI: node scripts/build-registry.mjs --out <file> [--apps-dir apps] [--sidecars dist-bundles]
// Env: GITHUB_REPOSITORY (required), ASSET_BASE_URL (default https://apps.bffless.dev),
//      GITHUB_STEP_SUMMARY (optional — omission lines are appended when set).

import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i

// Source commit for a bundle, from the `.commit` sidecar written by build-app-bundle.mjs and
// published beside `.sha256` (bffless/apps#276). Absent for every release cut before that
// change, and for bundles built from an unresolvable commit — both are normal, so this returns
// undefined and the entry simply carries no `commit`.
//
// Read from the sidecar rather than github.sha because registry.json is rebuilt by
// deploy-store.yml too, where no bundle is built and github.sha belongs to none of the entries.
// Anything that is not a bare 40-hex sha is dropped: a garbled sidecar must not surface as a
// plausible-looking commit that links somewhere wrong.
function readSourceCommit(sidecarsDir, baseName) {
  const commitPath = join(sidecarsDir, `${baseName}.commit`)
  if (!existsSync(commitPath)) return undefined
  const raw = readFileSync(commitPath, 'utf8').trim()
  if (!COMMIT_PATTERN.test(raw)) {
    console.log(`::warning title=app-catalog registry::${baseName}.commit is not a 40-hex sha — omitting commit`)
    return undefined
  }
  return raw.toLowerCase()
}

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
      // Provenance. Both optional and additive: a CE that predates them ignores them, and a
      // newer CE reading an older entry simply has no commit to show. Note CE does NOT depend
      // on these for the install itself — it reads .bffless-build.json from inside the bundle,
      // so it never has to trust the registry for the commit it stamps on a deployment.
      commit: readSourceCommit(sidecarsDir, baseName),
      releaseTag: `${app}-v${manifest.version}`,
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
