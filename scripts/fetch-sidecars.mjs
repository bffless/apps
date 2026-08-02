#!/usr/bin/env node
// Downloads the published sidecars for every manifested app (apps/*/bffless-app.json) into
// --sidecars, skipping files already present (e.g. the bundle just built by app-bundles.yml):
//
//   <app>-v<version>.bundle.sha256  — REQUIRED; its absence omits the app from registry.json
//   <app>-v<version>.bundle.commit  — OPTIONAL; source commit (bffless/apps#276). Releases cut
//                                     before that change have no .commit asset, which is a
//                                     normal steady state, not an error.
//
// An app with a manifest but no published release yet is skipped with a log line, not a
// failure — wiring up a new app's manifest must not break the registry build for existing
// apps. A transient `gh` failure (auth/network) is NOT treated as "no release" — it fails the
// script loudly, so CI never silently publishes a smaller registry. The same distinction is
// kept for .commit by asking the release which assets it HAS rather than by pattern-matching
// gh's failure text: a missing asset is skipped, but a failed download of an asset the release
// does list still fails loudly.
// Replaces the inline bash loop in app-bundles.yml so release.yml's publish-registry job can
// share it. Requires the `gh` CLI (GH_TOKEN in CI).

import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const opt = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i === -1 ? fallback : args[i + 1]
}
const sidecarsDir = opt('--sidecars', 'dist-bundles')
const repo = opt('--repo', process.env.GITHUB_REPOSITORY || 'bffless/apps')

function fail(message) {
  console.error(`fetch-sidecars: ${message}`)
  process.exit(1)
}

mkdirSync(sidecarsDir, { recursive: true })
const appsDir = 'apps'
const apps = readdirSync(appsDir).filter((name) => statSync(join(appsDir, name)).isDirectory())

for (const app of apps) {
  const manifestPath = join(appsDir, app, 'bffless-app.json')
  if (!existsSync(manifestPath)) continue
  const { version } = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const baseName = `${app}-v${version}.bundle`
  if (existsSync(join(sidecarsDir, `${baseName}.sha256`))) continue // just built in this run
  const tag = `${app}-v${version}`

  // Check existence first so a genuinely-missing release (expected, common) is distinguishable
  // from a transient gh failure (auth/network — must fail the build, not silently omit).
  // `--json assets` additionally tells us which optional sidecars this release actually carries.
  const view = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'], {
    stdio: 'pipe',
    encoding: 'utf8',
  })
  if (view.status !== 0) {
    if (/release not found/i.test(view.stderr || '')) {
      console.log(`no published release for ${tag} yet — omitting from registry.json`)
      continue
    }
    console.error(view.stderr || `gh release view ${tag} failed with no stderr output`)
    fail(`gh release view ${tag} failed unexpectedly (not a "release not found" — likely auth/network) — see stderr above`)
  }

  let assetNames = []
  try {
    assetNames = (JSON.parse(view.stdout).assets ?? []).map((asset) => asset.name)
  } catch (err) {
    fail(`could not parse the asset list for ${tag}: ${err.message}`)
  }

  const download = (pattern) => {
    const result = spawnSync(
      'gh',
      ['release', 'download', tag, '--repo', repo, '--pattern', pattern, '--dir', sidecarsDir, '--clobber'],
      { stdio: 'pipe', encoding: 'utf8' },
    )
    if (result.status !== 0) {
      console.error(result.stderr || `gh release download ${tag} failed with no stderr output`)
      fail(`gh release download ${tag} (${pattern}) failed — see stderr above`)
    }
  }

  download(`${baseName}.sha256`)

  // Optional: absent on every release cut before bffless/apps#276. registry.json simply carries
  // no `commit` for those, and CE falls back to the bundle hash — no failure, no guessed value.
  if (assetNames.includes(`${baseName}.commit`)) {
    download(`${baseName}.commit`)
  } else {
    console.log(`${tag} has no .commit sidecar — registry entry will omit the source commit`)
  }
}
