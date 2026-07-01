#!/usr/bin/env node
// Enforces the per-app pipelines convention (bffless/apps#85): every app in the
// monorepo must ship its backend export + a README with the two required sections,
// so the single GETTING-STARTED.md guide installs any app without a rewrite and the
// per-app manual admin-panel steps are always surfaced to the reader.
//
// For each apps/<app>/ directory this fails (exit 1) unless ALL hold:
//   1. apps/<app>/bffless/<app>.proxy-rules.json exists (the exported backend);
//   2. apps/<app>/bffless/README.md exists;
//   3. that README contains a "Manual setup (admin panel)" heading;
//   4. that README contains a "First-success checkpoint" heading.
//
// Run: node scripts/check-app-conventions.mjs   (pnpm apps:check)

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const appsDir = join(repoRoot, 'apps')

// Required README headings. Matched as a markdown heading line (any level),
// case-insensitive, so a heading rename that keeps the wording still passes.
const REQUIRED_SECTIONS = [
  { label: 'Manual setup (admin panel)', re: /^#{1,6}\s+manual setup \(admin panel\)/im },
  { label: 'First-success checkpoint', re: /^#{1,6}\s+first-success checkpoint/im },
]

function listAppDirs() {
  if (!existsSync(appsDir)) return []
  return readdirSync(appsDir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(appsDir, name)).isDirectory())
    .sort()
}

function checkApp(app) {
  const errors = []
  const bfflessDir = join(appsDir, app, 'bffless')
  const rulesRel = `apps/${app}/bffless/${app}.proxy-rules.json`
  const readmeRel = `apps/${app}/bffless/README.md`

  if (!existsSync(join(appsDir, app, 'bffless', `${app}.proxy-rules.json`))) {
    errors.push(`missing ${rulesRel} (exported proxy rule set)`)
  }

  const readmePath = join(bfflessDir, 'README.md')
  if (!existsSync(readmePath)) {
    errors.push(`missing ${readmeRel}`)
  } else {
    const readme = readFileSync(readmePath, 'utf8')
    for (const section of REQUIRED_SECTIONS) {
      if (!section.re.test(readme)) {
        errors.push(`${readmeRel} is missing the "${section.label}" section`)
      }
    }
  }
  return errors
}

function main() {
  const apps = listAppDirs()
  if (apps.length === 0) {
    console.error('No apps/ directory found — nothing to check.')
    process.exit(1)
  }

  const failures = []
  for (const app of apps) {
    const errors = checkApp(app)
    if (errors.length === 0) {
      console.log(`✓ ${app}`)
    } else {
      console.log(`✗ ${app}`)
      for (const err of errors) {
        console.log(`    - ${err}`)
        failures.push(`${app}: ${err}`)
      }
    }
  }

  if (failures.length > 0) {
    console.error(
      `\nApp-pipelines convention check failed (${failures.length} problem(s)).\n` +
        'Every apps/<app>/ must ship apps/<app>/bffless/<app>.proxy-rules.json and\n' +
        'apps/<app>/bffless/README.md with a "Manual setup (admin panel)" and a\n' +
        '"First-success checkpoint" section. See docs/app-pipelines-convention.md.',
    )
    process.exit(1)
  }

  console.log(`\nAll ${apps.length} app(s) satisfy the per-app pipelines convention.`)
}

main()
