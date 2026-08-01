#!/usr/bin/env node
// Downloads the published sha256 sidecar for every manifested app (apps/*/bffless-app.json)
// into --sidecars, skipping files already present (e.g. the bundle just built by
// app-bundles.yml). An app with a manifest but no published release yet is skipped with a
// log line, not a failure — wiring up a new app's manifest must not break the registry
// build for existing apps. Replaces the inline bash loop in app-bundles.yml so
// deploy-store.yml can share it. Requires the `gh` CLI (GH_TOKEN in CI).

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
  const result = spawnSync(
    'gh',
    ['release', 'download', tag, '--repo', repo, '--pattern', `${baseName}.sha256`, '--dir', sidecarsDir, '--clobber'],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) {
    console.log(`no published release for ${tag} yet — omitting from registry.json`)
  }
}
