#!/usr/bin/env node
// Enforces the per-app pipelines convention (bffless/apps#85): every app in the
// monorepo must ship its backend export + a README with the two required sections,
// so the single GETTING-STARTED.md guide installs any app without a rewrite and the
// per-app manual admin-panel steps are always surfaced to the reader.
//
// For each apps/<app>/ directory this fails (exit 1) unless ALL hold:
//   1. its backend is shipped as an authored set at apps/<app>/.bffless/proxy-rules/*/ruleset.yaml;
//   2. apps/<app>/bffless/README.md exists;
//   3. that README contains a "Manual setup (admin panel)" heading;
//   4. that README contains a "First-success checkpoint" heading.
//
// A raw apps/<app>/bffless/<app>.proxy-rules.json export used to satisfy (1). That form is retired
// (bffless/apps#231 converted Handoff, the last app on it), so a lingering export is now an ERROR
// rather than an alternative — otherwise an app could quietly regress to a hand-patched JSON blob
// that no test or `rules diff` covers. See docs/app-pipelines-convention.md.
//
// Run: node scripts/check-app-conventions.mjs   (pnpm apps:check)

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const appsDir = join(repoRoot, 'apps')

// The marketplace listing's metadata.version must match the plugin it points at, or a
// consumer installing via `/plugin marketplace add` sees a stale version label.
function checkMarketplaceVersion() {
  const marketplacePath = join(repoRoot, '.claude-plugin', 'marketplace.json')
  const pluginPath = join(repoRoot, 'plugins', 'bffless-apps', '.claude-plugin', 'plugin.json')

  if (!existsSync(marketplacePath)) return [`missing .claude-plugin/marketplace.json`]
  if (!existsSync(pluginPath)) return [`missing plugins/bffless-apps/.claude-plugin/plugin.json`]

  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'))
  const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'))
  const marketplaceVersion = marketplace.metadata?.version
  const pluginVersion = plugin.version

  if (marketplaceVersion !== pluginVersion) {
    return [
      `.claude-plugin/marketplace.json metadata.version (${marketplaceVersion}) does not match ` +
        `plugins/bffless-apps/.claude-plugin/plugin.json version (${pluginVersion}) — bump them together`,
    ]
  }
  return []
}

// Required README headings. Matched as a markdown heading line (any level),
// case-insensitive, so a heading rename that keeps the wording still passes.
const REQUIRED_SECTIONS = [
  { label: 'Manual setup (admin panel)', re: /^#{1,6}\s+manual setup \(admin panel\)/im },
  { label: 'First-success checkpoint', re: /^#{1,6}\s+first-success checkpoint/im },
]

// Mirrors PLACEHOLDER_TOKENS in the CE repo's app-manifest.util.ts.
const PLACEHOLDER_TOKENS = ['projectPath', 'appHost']
// A note's body is at most three short lines in the install dialog's width.
const MAX_BODY_CHARS = 220

function readJson(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function listAppDirs() {
  if (!existsSync(appsDir)) return []
  return readdirSync(appsDir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => statSync(join(appsDir, name)).isDirectory())
    .sort()
}

// An authored set passes if at least one apps/<app>/.bffless/proxy-rules/<set>/
// directory has a ruleset.yaml (readdirSync, not fs.globSync — this runs on
// plain Node 20 in CI).
function hasAuthoredSet(app) {
  const root = join(appsDir, app, '.bffless', 'proxy-rules')
  if (!existsSync(root)) return false
  return readdirSync(root).some((d) => existsSync(join(root, d, 'ruleset.yaml')))
}

function checkApp(app) {
  const errors = []
  const bfflessDir = join(appsDir, app, 'bffless')
  const rulesRel = `apps/${app}/bffless/${app}.proxy-rules.json`
  const authoredRel = `apps/${app}/.bffless/proxy-rules/*/ruleset.yaml`
  const readmeRel = `apps/${app}/bffless/README.md`

  if (!hasAuthoredSet(app)) {
    errors.push(`missing backend: no authored rule set at ${authoredRel}`)
  }

  // The retired raw-export form. Fail loudly rather than ignoring it, so a re-introduced export
  // can't sit alongside the authored set as a second, un-synced source of truth.
  if (existsSync(join(appsDir, app, 'bffless', `${app}.proxy-rules.json`))) {
    errors.push(
      `${rulesRel} is a raw proxy-rules export — that form is retired; author the set under ` +
        `${authoredRel} instead (docs/app-pipelines-convention.md)`,
    )
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

  errors.push(...checkManifest(app))
  return errors
}

// bffless-app.json is OPTIONAL per app — the app catalog is opt-in. Only apps that ship one
// (currently Handoff) are validated here; Studio/Reader without a manifest are unaffected.
// This is a lightweight, dependency-free mirror of the CE-side `validateAppManifest` shape
// checks (apps/backend/src/app-catalog/app-manifest.util.ts in the bffless/ce repo) — just
// enough to catch a manifest that would fail CE install before it ships, without importing
// across repos. It does not attempt to be a full re-implementation of every CE-side rule.
function checkManifest(app) {
  const manifestPath = join(appsDir, app, 'bffless-app.json')
  if (!existsSync(manifestPath)) return []

  const manifestRel = `apps/${app}/bffless-app.json`
  const errors = []

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    return [`${manifestRel}: invalid JSON (${err.message})`]
  }

  if (manifest.schemaVersion !== 1) {
    errors.push(`${manifestRel}: schemaVersion must be 1`)
  }
  if (manifest.id !== app) {
    errors.push(`${manifestRel}: id ("${manifest.id}") must equal the app directory name ("${app}")`)
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(manifest.version)) {
    errors.push(`${manifestRel}: version must be a semver string (got ${JSON.stringify(manifest.version)})`)
  }

  const install = manifest.install
  if (install == null || typeof install !== 'object') {
    errors.push(`${manifestRel}: install: required object`)
  } else {
    if (!install.alias || typeof install.alias !== 'string') {
      errors.push(`${manifestRel}: install.alias: required non-empty string`)
    }
    if (!install.domain || typeof install.domain.subdomain !== 'string' || !install.domain.subdomain) {
      errors.push(`${manifestRel}: install.domain.subdomain: required non-empty string`)
    }

    const ruleSets = install.ruleSets
    if (!Array.isArray(ruleSets) || ruleSets.length === 0) {
      errors.push(`${manifestRel}: install.ruleSets: required non-empty array`)
    } else {
      ruleSets.forEach((entry, i) => {
        const file = entry && entry.file
        const match = typeof file === 'string' && /^rulesets\/([a-zA-Z0-9._-]+)\.json$/.exec(file)
        if (!match) {
          errors.push(
            `${manifestRel}: install.ruleSets[${i}].file must match rulesets/<name>.json (got ${JSON.stringify(file)})`,
          )
          return
        }
        const setName = match[1]
        const setDir = join(appsDir, app, '.bffless', 'proxy-rules', setName)
        if (!existsSync(join(setDir, 'ruleset.yaml'))) {
          errors.push(
            `${manifestRel}: install.ruleSets[${i}].file ("${file}") has no matching authored set at ` +
              `apps/${app}/.bffless/proxy-rules/${setName}/ruleset.yaml`,
          )
        }
      })
    }
  }

  // Store metadata (docs/superpowers/specs/2026-08-01-app-store-frontend-design.md):
  // a cataloged app must ship its store-facing content, or the registry entry and
  // store page render half-empty with no failure anywhere.
  const catalogRel = `apps/${app}/catalog`
  if (!existsSync(join(appsDir, app, 'catalog', 'description.md'))) {
    errors.push(`missing ${catalogRel}/description.md — required for apps with a bffless-app.json`)
  }
  if (!existsSync(join(appsDir, app, 'catalog', 'thumbnail.png'))) {
    errors.push(`missing ${catalogRel}/thumbnail.png — required for apps with a bffless-app.json`)
  }
  if (manifest.category !== undefined && typeof manifest.category !== 'string') {
    errors.push(`${manifestRel}: category must be a string when present`)
  }

  errors.push(...checkManualSteps(manifest, manifestRel))

  return errors
}

/**
 * A setup note is read, not completed: title is the action, body is at most
 * three short lines. A note that needs a conditional to decide whether it
 * applies to the reader belongs in the app's README instead.
 */
export function checkManualSteps(manifest, manifestRel) {
  const steps = manifest?.install?.manualSteps
  if (!Array.isArray(steps)) return []

  const errors = []

  steps.forEach((step, i) => {
    const at = `${manifestRel}: install.manualSteps[${i}]`

    if (typeof step?.body === 'string' && step.body.length > MAX_BODY_CHARS) {
      errors.push(
        `${at}.body: ${step.body.length} characters, max ${MAX_BODY_CHARS} — ` +
          `shorten it, or move the detail to the app README`,
      )
    }

    for (const field of ['title', 'body', 'deepLink']) {
      const value = step?.[field]
      if (typeof value !== 'string') continue
      for (const match of value.matchAll(/\{([^}]*)\}/g)) {
        if (!PLACEHOLDER_TOKENS.includes(match[1])) {
          errors.push(
            `${at}.${field}: unknown placeholder {${match[1]}} ` +
              `(known: ${PLACEHOLDER_TOKENS.join(', ')})`,
          )
        }
      }
    }
  })

  return errors
}

/**
 * The catalog apps and the release-please components must be the same set, and
 * each component's tag must come out as `<app>-v<version>` — the shape
 * build-registry.mjs looks up and every existing release already uses. An app
 * with no component is never versioned or released, and the symptom (it never
 * appears in the registry) shows up far from the cause.
 */
export function checkReleaseComponents(config, appIds, manifest) {
  const errors = []
  const packages = config?.packages ?? {}
  const configured = Object.keys(packages)

  for (const app of appIds) {
    const key = `apps/${app}`
    if (!configured.includes(key)) {
      errors.push(
        `release-please-config.json: no component for ${key} — a catalog app with no component is never released`,
      )
      continue
    }
    if (manifest?.[key] === undefined) {
      errors.push(`.release-please-manifest.json: missing an entry for ${key}`)
    }
    const entry = packages[key]
    if (entry.component !== app || entry['include-component-in-tag'] !== true) {
      errors.push(
        `release-please-config.json: ${key} must set component "${app}" and include-component-in-tag true ` +
          `so its tag is ${app}-v<version> (got component ${JSON.stringify(entry.component)})`,
      )
    }
  }

  for (const key of configured) {
    const app = key.startsWith('apps/') ? key.slice('apps/'.length) : null
    if (app && !appIds.includes(app)) {
      errors.push(
        `release-please-config.json: ${key} has a component but ships no bffless-app.json`,
      )
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

  const marketplaceErrors = checkMarketplaceVersion()
  if (marketplaceErrors.length === 0) {
    console.log(`✓ marketplace.json version matches plugin.json`)
  } else {
    console.log(`✗ marketplace.json version`)
    for (const err of marketplaceErrors) {
      console.log(`    - ${err}`)
      failures.push(err)
    }
  }

  const releaseErrors = checkReleaseComponents(
    readJson(join(repoRoot, 'release-please-config.json')),
    apps.filter((app) => existsSync(join(appsDir, app, 'bffless-app.json'))),
    readJson(join(repoRoot, '.release-please-manifest.json')),
  )
  if (releaseErrors.length === 0) {
    console.log(`✓ release-please components match the catalog apps`)
  } else {
    console.log(`✗ release-please components`)
    for (const err of releaseErrors) {
      console.log(`    - ${err}`)
      failures.push(err)
    }
  }

  if (failures.length > 0) {
    console.error(
      `\nApp-pipelines convention check failed (${failures.length} problem(s)).\n` +
        'Every apps/<app>/ must ship its backend as an authored rule set at\n' +
        'apps/<app>/.bffless/proxy-rules/<set>/ruleset.yaml (raw *.proxy-rules.json exports are\n' +
        'retired), plus apps/<app>/bffless/README.md with a "Manual setup (admin panel)" and a\n' +
        '"First-success checkpoint" section. See docs/app-pipelines-convention.md.',
    )
    process.exit(1)
  }

  console.log(`\nAll ${apps.length} app(s) satisfy the per-app pipelines convention.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
