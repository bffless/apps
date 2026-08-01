# App Store Frontend (apps.bffless.dev) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static store site on apps.bffless.dev showcasing the apps in `registry.json`, plus a metadata pipeline (`apps/<app>/catalog/` → registry fields + hosted assets) usable by every registry consumer.

**Architecture:** One composite deployment artifact (site pages + `registry.json` + `assets/<app>/…`) built by a shared script and published to the existing `app-registry` alias by two workflows (`app-bundles.yml` after an app publish; new `deploy-store.yml` on store/metadata changes). The registry builder moves from an inline workflow heredoc to a tested module that folds in per-app catalog metadata.

**Tech Stack:** Astro 5 + Tailwind v3 (static output, same combo as `repos/deployment-docs`), `marked` for description markdown, plain Node 20 scripts tested with built-in `node:test`, `bffless/upload-artifact@v1` for deploys.

**Spec:** `docs/superpowers/specs/2026-08-01-app-store-frontend-design.md` (read it first).

## Global Constraints

- Work happens in the `store-frontend` worktree (`.claude/worktrees/store-frontend` of `/home/rico/bffless/repos/apps`), branch `store-frontend`. Never push to `main`; the deliverable is a PR.
- Node >= 20, pnpm 10 (`packageManager: pnpm@10.33.0`). Scripts must run on plain Node 20 in CI (no `fs.globSync`, no experimental flags beyond `node --test`).
- `registry.json` stays `schemaVersion: 1`; changes are strictly additive. `https://apps.bffless.dev/registry.json` must never break (CE's hardcoded default).
- Asset URLs in the registry are absolute and **unversioned**: `https://apps.bffless.dev/assets/<app>/…`.
- The store package lives at `store/` (top-level), NOT under `apps/` (app conventions must not apply to it).
- The store lists **only** registry entries; CTA is showcase-only (instructions + get-CE link, no deep links into a visitor's instance).
- End every commit message with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Existing behavior to preserve verbatim: registry omission `::warning` annotations + `GITHUB_STEP_SUMMARY` lines; the `app-bundles` concurrency group with `cancel-in-progress: false`.

---

### Task 1: `scripts/build-registry.mjs` — extract the registry builder, fold in catalog metadata

**Files:**
- Create: `scripts/build-registry.mjs`
- Create: `scripts/build-registry.test.mjs`
- Modify: `package.json` (root — add `scripts:test`)

**Interfaces:**
- Consumes: `apps/<app>/bffless-app.json` manifests, `<sidecarsDir>/<app>-v<version>.bundle.sha256` sidecars, `apps/<app>/catalog/` content.
- Produces: `buildRegistry({ appsDir, sidecarsDir, assetBaseUrl, repo })` → `{ registry, omitted }` where `registry = { schemaVersion: 1, apps: RegistryEntry[] }` and `omitted = Array<{ id, version }>`. Entry fields: `id, name, version, bundleUrl, sha256, summary, description?, category?, iconUrl?, thumbnailUrl?, screenshots?, docsUrl?, sourceUrl?, requires?`. CLI: `node scripts/build-registry.mjs --out <file> [--apps-dir apps] [--sidecars dist-bundles]`, env `GITHUB_REPOSITORY` (required for CLI), `ASSET_BASE_URL` (default `https://apps.bffless.dev`), `GITHUB_STEP_SUMMARY` (optional). Task 6's orchestrator and Task 7's workflows call this.

- [ ] **Step 1: Write the failing tests**

`scripts/build-registry.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistry } from './build-registry.mjs'

const ASSET_BASE = 'https://apps.bffless.dev'
const REPO = 'bffless/apps'

// Lays out <tmp>/apps/<id>/bffless-app.json (+ optional catalog/) and
// <tmp>/dist-bundles/<id>-v<version>.bundle.sha256, returning the paths buildRegistry needs.
function makeFixture({ id = 'demo', version = '1.0.0', manifestExtra = {}, catalog = null, sidecar = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'build-registry-'))
  const appsDir = join(root, 'apps')
  const sidecarsDir = join(root, 'dist-bundles')
  mkdirSync(join(appsDir, id), { recursive: true })
  mkdirSync(sidecarsDir, { recursive: true })
  writeFileSync(
    join(appsDir, id, 'bffless-app.json'),
    JSON.stringify({ schemaVersion: 1, id, name: id, version, summary: 's', ...manifestExtra }),
  )
  if (sidecar) {
    writeFileSync(join(sidecarsDir, `${id}-v${version}.bundle.sha256`), `abc123  ${id}-v${version}.bundle.zip\n`)
  }
  if (catalog) {
    const catalogDir = join(appsDir, id, 'catalog')
    mkdirSync(join(catalogDir, 'screenshots'), { recursive: true })
    if (catalog.description) writeFileSync(join(catalogDir, 'description.md'), catalog.description)
    if (catalog.thumbnail) writeFileSync(join(catalogDir, 'thumbnail.png'), 'png')
    if (catalog.icon) writeFileSync(join(catalogDir, 'icon.png'), 'png')
    for (const shot of catalog.screenshots ?? []) writeFileSync(join(catalogDir, 'screenshots', shot), 'png')
  }
  return { appsDir, sidecarsDir }
}

test('builds an entry with bundleUrl and sha256 from the sidecar', () => {
  const { appsDir, sidecarsDir } = makeFixture()
  const { registry, omitted } = buildRegistry({ appsDir, sidecarsDir, assetBaseUrl: ASSET_BASE, repo: REPO })
  assert.equal(omitted.length, 0)
  assert.equal(registry.schemaVersion, 1)
  assert.equal(registry.apps.length, 1)
  const entry = registry.apps[0]
  assert.equal(entry.id, 'demo')
  assert.equal(entry.sha256, 'abc123')
  assert.equal(entry.bundleUrl, 'https://github.com/bffless/apps/releases/download/demo-v1.0.0/demo-v1.0.0.bundle.zip')
})

test('omits an app whose sidecar is missing', () => {
  const { appsDir, sidecarsDir } = makeFixture({ sidecar: false })
  const { registry, omitted } = buildRegistry({ appsDir, sidecarsDir, assetBaseUrl: ASSET_BASE, repo: REPO })
  assert.equal(registry.apps.length, 0)
  assert.deepEqual(omitted, [{ id: 'demo', version: '1.0.0' }])
})

test('folds catalog metadata: description, thumbnailUrl, iconUrl, sorted screenshots', () => {
  const { appsDir, sidecarsDir } = makeFixture({
    manifestExtra: { category: 'files' },
    catalog: { description: '# Demo\nLong text.', thumbnail: true, icon: true, screenshots: ['b.png', 'a.png'] },
  })
  const entry = buildRegistry({ appsDir, sidecarsDir, assetBaseUrl: ASSET_BASE, repo: REPO }).registry.apps[0]
  assert.equal(entry.description, '# Demo\nLong text.')
  assert.equal(entry.category, 'files')
  assert.equal(entry.thumbnailUrl, `${ASSET_BASE}/assets/demo/thumbnail.png`)
  assert.equal(entry.iconUrl, `${ASSET_BASE}/assets/demo/icon.png`)
  assert.deepEqual(entry.screenshots, [
    `${ASSET_BASE}/assets/demo/screenshots/a.png`,
    `${ASSET_BASE}/assets/demo/screenshots/b.png`,
  ])
})

test('an explicit manifest iconUrl wins over the derived one', () => {
  const { appsDir, sidecarsDir } = makeFixture({
    manifestExtra: { iconUrl: 'https://example.com/icon.png' },
    catalog: { description: 'd', thumbnail: true, icon: true },
  })
  const entry = buildRegistry({ appsDir, sidecarsDir, assetBaseUrl: ASSET_BASE, repo: REPO }).registry.apps[0]
  assert.equal(entry.iconUrl, 'https://example.com/icon.png')
})

test('an app without catalog/ still gets an entry, with metadata fields absent', () => {
  const { appsDir, sidecarsDir } = makeFixture()
  const entry = buildRegistry({ appsDir, sidecarsDir, assetBaseUrl: ASSET_BASE, repo: REPO }).registry.apps[0]
  assert.equal(entry.description, undefined)
  assert.equal(entry.thumbnailUrl, undefined)
  assert.equal(entry.screenshots, undefined)
})
```

- [ ] **Step 2: Add the test script and run to verify failure**

In root `package.json` `scripts`, add: `"scripts:test": "node --test scripts/"`.

Run: `pnpm scripts:test`
Expected: FAIL — `Cannot find module '.../scripts/build-registry.mjs'`

- [ ] **Step 3: Write `scripts/build-registry.mjs`**

Port the heredoc from `.github/workflows/app-bundles.yml` ("Build registry.json" step) into a module, adding catalog folding. Keep the omission warnings byte-compatible in spirit (same `::warning title=app-catalog registry::` prefix and step-summary line):

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm scripts:test`
Expected: PASS (5 tests). If `node --test scripts/` picks up no files, name-check: node's test runner matches `*.test.mjs` — it does.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-registry.mjs scripts/build-registry.test.mjs package.json
git commit -m "feat: extract registry builder into a tested script with catalog metadata folding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `scripts/fetch-sidecars.mjs` — shared sidecar fetching

**Files:**
- Create: `scripts/fetch-sidecars.mjs`

**Interfaces:**
- Consumes: `apps/*/bffless-app.json` manifests; `gh` CLI (authenticated via `GH_TOKEN` in CI, the user's `gh auth` locally).
- Produces: `<sidecarsDir>/<app>-v<version>.bundle.sha256` files for every manifested app that has a published release; skips (with the existing log line) apps without one. CLI: `node scripts/fetch-sidecars.mjs [--sidecars dist-bundles] [--repo bffless/apps]`. Skips any sidecar already present (so `app-bundles.yml` can run it after building one app's bundle without re-downloading it). Both workflows in Task 7 call this instead of the current inline bash loop.

- [ ] **Step 1: Write the script**

This is CI glue around `gh release download` — no unit test; verified by a live run in Step 2 and by CI in Task 7. Port of the "Fetch sha256 sidecars for other published apps" bash loop in `app-bundles.yml`:

```js
#!/usr/bin/env node
// Downloads the published sha256 sidecar for every manifested app (apps/*/bffless-app.json)
// into --sidecars, skipping files already present (e.g. the bundle just built by
// app-bundles.yml). An app with a manifest but no published release yet is skipped with a
// log line, not a failure — wiring up a new app's manifest must not break the registry
// build for existing apps. Replaces the inline bash loop in app-bundles.yml so
// deploy-store.yml can share it. Requires the `gh` CLI (GH_TOKEN in CI).

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
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
```

Note the `readFileSync` import: add it to the `node:fs` import list (`existsSync, mkdirSync, readdirSync, statSync, readFileSync`).

- [ ] **Step 2: Verify with a live run**

Run (from the worktree root): `node scripts/fetch-sidecars.mjs --sidecars /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/sidecars`
Expected: downloads `handoff-v1.0.0.bundle.sha256` into that dir (Handoff is the only published app). Then run `GITHUB_REPOSITORY=bffless/apps node scripts/build-registry.mjs --out /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/registry.json --sidecars /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/sidecars` and confirm the output matches the live `https://apps.bffless.dev/registry.json` (same entry; new fields absent because Handoff has no `catalog/` yet).

- [ ] **Step 3: Commit**

```bash
git add scripts/fetch-sidecars.mjs
git commit -m "feat: shared sidecar-fetch script for registry builds

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Handoff catalog content

**Files:**
- Create: `apps/handoff/catalog/description.md`
- Create: `apps/handoff/catalog/thumbnail.png`
- Create: `apps/handoff/catalog/icon.png`
- Create: `apps/handoff/catalog/screenshots/*.png` (2–4 screenshots)

**Interfaces:**
- Consumes: the running Handoff dev server (MSW mocks are ON by default in dev — `apps/handoff/src/mocks/config.ts`), `localdev-tools/shot.mjs`.
- Produces: the files Task 1's `readCatalog` folds into the registry and Task 4's conventions check requires.

- [ ] **Step 1: Write `description.md`**

Source material: `apps/handoff/bffless/README.md` and the repo README's Handoff row. Long-form marketing/explainer markdown (NOT the setup README — this is store copy). Start from:

```markdown
Handoff is an internal, permissioned file server that runs entirely on your BFFless project —
no separate backend to deploy or maintain.

Upload documents, prototypes, images, videos, or whole static Sites; organize them into
folders; and control exactly who sees each folder with per-folder access grants, group
sharing, and share links for people outside your team. Uploaded HTML bundles are served
back live, so a designer can hand off a clickable prototype the same way they hand off a PDF.

## Highlights

- **Per-folder access control** — grant people or groups access folder by folder; everything
  else stays private to its owner.
- **Share links** — hand a token-scoped link to someone without an account.
- **Live Sites** — uploaded static bundles (HTML/CSS/JS) are served as browsable sites,
  including a chromeless embed mode other tools can iframe.
- **Comments** — Google-Docs-style margin comments on shared content.
- **RSS feeds** — follow a public folder's updates from any feed reader.

## How it works

Handoff's frontend is a static React app; its entire backend is a BFFless proxy rule set —
pipelines for presigned uploads, an access-controlled node tree, serving, grants, and share
links. Installing it from the catalog deploys the frontend and attaches the rule sets to a
`handoff` alias on your instance in one click.
```

Review it against the actual feature set in `apps/handoff/bffless/README.md` and adjust — do not ship claims the app doesn't have.

- [ ] **Step 2: Generate screenshots with the headless browser**

```bash
cd /home/rico/bffless/repos/apps/.claude/worktrees/store-frontend
pnpm install
pnpm handoff:dev &   # port 5173; MSW mocks default ON in dev, so seeded content renders
sleep 8
cd /home/rico/bffless/localdev-tools
node shot.mjs "http://localhost:5173/" --out /home/rico/bffless/repos/apps/.claude/worktrees/store-frontend/apps/handoff/catalog/screenshots/01-folders.png --width 1440 --height 900
```

Take 2–4 shots of distinct surfaces (folder listing, a file/Site viewer, the share dialog if reachable by URL). Use the mock-seeded data (`apps/handoff/src/mocks/handlers.ts` shows what routes have content). READ each PNG afterwards (the Read tool renders images) and confirm it shows real content, not a spinner or error state; re-shoot with `--wait <selector>` if needed. Kill the dev server when done.

- [ ] **Step 3: Create thumbnail and icon**

- `thumbnail.png`: a 1200×630 shot (OG-card dimensions) of the most visually representative screen: `node shot.mjs "http://localhost:5173/" --out .../catalog/thumbnail.png --width 1200 --height 630`.
- `icon.png`: Handoff only ships `favicon.svg` (`apps/handoff/public/favicon.svg`). Rasterize it at 256×256 using the headless browser: write a tiny HTML file in the scratchpad that displays the SVG at 256×256 on a transparent/white background, then `node shot.mjs file:///<that>.html --out .../catalog/icon.png --width 256 --height 256`.

READ both images to verify they look right.

- [ ] **Step 4: Verify the registry builder picks the content up**

Run: `GITHUB_REPOSITORY=bffless/apps node scripts/build-registry.mjs --out /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/registry2.json --sidecars /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/sidecars`
Expected: the handoff entry now carries `description`, `thumbnailUrl`, `iconUrl`, `screenshots`.

- [ ] **Step 5: Commit**

```bash
git add apps/handoff/catalog
git commit -m "feat(handoff): store catalog content — description, thumbnail, icon, screenshots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Extend the app-conventions check

**Files:**
- Modify: `scripts/check-app-conventions.mjs` (inside `checkManifest`, after the successful `JSON.parse`)

**Interfaces:**
- Consumes: `apps/<app>/catalog/` created in Task 3.
- Produces: `pnpm apps:check` fails for any app that ships `bffless-app.json` without `catalog/description.md` + `catalog/thumbnail.png`, or with a non-string `category`.

- [ ] **Step 1: Verify the check passes today (baseline)**

Run: `pnpm apps:check`
Expected: PASS (Task 3 already added Handoff's catalog).

- [ ] **Step 2: Add the checks**

Append inside `checkManifest(app)`, after the existing `install` checks and before the final `return errors`:

```js
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
```

- [ ] **Step 3: Verify both directions**

Run: `pnpm apps:check` → PASS.
Then `mv apps/handoff/catalog/description.md /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/ && pnpm apps:check` → FAIL mentioning `apps/handoff/catalog/description.md`; restore the file and re-run → PASS.

- [ ] **Step 4: Update the convention doc**

Add a short subsection to `docs/app-pipelines-convention.md` under the existing "App-catalog manifest" section: apps with a manifest must also ship `catalog/description.md` + `catalog/thumbnail.png` (optional `icon.png`, `screenshots/`), folded into `registry.json` by `scripts/build-registry.mjs` and served from `https://apps.bffless.dev/assets/<app>/…`.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-app-conventions.mjs docs/app-pipelines-convention.md
git commit -m "feat: require store catalog content for cataloged apps in apps:check

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Store package scaffold + registry loader

**Files:**
- Create: `store/package.json`, `store/astro.config.mjs`, `store/tailwind.config.mjs`, `store/tsconfig.json`
- Create: `store/src/lib/registry.ts`
- Create: `store/dev-registry.json`
- Create: `store/src/pages/index.astro` (minimal placeholder — real pages in Task 6)
- Modify: `pnpm-workspace.yaml`, root `package.json`, `.gitignore`

**Interfaces:**
- Consumes: `registry.json` shape from Task 1 (via `REGISTRY_FILE` env, falling back to `store/dev-registry.json`).
- Produces: `loadRegistry(): Registry` and `assetPath(url?: string): string | undefined` in `store/src/lib/registry.ts`; `pnpm store:dev` / `pnpm store:build`; `store/dist/` output consumed by Task 6's pages and Task 7's orchestrator (which sets `REGISTRY_FILE` and stages `store/public/assets/`).

- [ ] **Step 1: Register the workspace and scaffold the package**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'store'
```

`store/package.json` (pin the same known-good major combo as `repos/deployment-docs`):

```json
{
  "name": "store",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev --port 4321",
    "build": "astro build",
    "preview": "astro preview --port 4321"
  },
  "dependencies": {
    "@astrojs/tailwind": "^5.1.0",
    "astro": "^5.7.0",
    "marked": "^15.0.0"
  },
  "devDependencies": {
    "tailwindcss": "^3.4.0",
    "typescript": "^5.6.0"
  }
}
```

`store/astro.config.mjs`:

```js
import { defineConfig } from 'astro/config'
import tailwind from '@astrojs/tailwind'

export default defineConfig({
  site: 'https://apps.bffless.dev',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [tailwind()],
})
```

`store/tailwind.config.mjs`:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
```

`store/tsconfig.json`:

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": ["src"]
}
```

Root `package.json` scripts — add:

```json
    "store:dev": "pnpm --filter store dev",
    "store:build": "pnpm --filter store build",
    "store:assets": "node scripts/build-store-artifact.mjs --stage-only",
```

(`store:assets` targets Task 6's script; it will fail until then — that's fine, nothing calls it yet.)

`.gitignore` — add:

```
store/dist/
store/public/assets/
/registry-staging/
.tmp-store/
```

(The composite output dir is named `registry-staging`, not `store-dist` — see Task 7's note on why that name is load-bearing.)

- [ ] **Step 2: Write the registry loader**

`store/src/lib/registry.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface RegistryEntry {
  id: string
  name?: string
  version: string
  bundleUrl: string
  sha256: string
  summary?: string
  description?: string
  category?: string
  iconUrl?: string
  thumbnailUrl?: string
  screenshots?: string[]
  docsUrl?: string
  sourceUrl?: string
  requires?: { presignedStorage?: boolean; ceMin?: string }
}

export interface Registry {
  schemaVersion: 1
  apps: RegistryEntry[]
}

const fallback = fileURLToPath(new URL('../../dev-registry.json', import.meta.url))

/** Build-time loader: REGISTRY_FILE is set by scripts/build-store-artifact.mjs in CI;
 *  local `astro dev` falls back to the committed dev fixture. */
export function loadRegistry(): Registry {
  const file = process.env.REGISTRY_FILE ?? fallback
  const registry = JSON.parse(readFileSync(file, 'utf8')) as Registry
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.apps)) {
    throw new Error(`invalid registry at ${file}`)
  }
  return registry
}

/** registry.json carries absolute asset URLs for external consumers (CE admin);
 *  the site serves those same files itself, so render them root-relative — that
 *  way dev, previews, and production all resolve. */
export function assetPath(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}
```

- [ ] **Step 3: Dev fixture + placeholder page**

`store/dev-registry.json` — the live registry plus the new fields (Handoff's real content lands via the build; this fixture is only for `astro dev`):

```json
{
  "schemaVersion": 1,
  "apps": [
    {
      "id": "handoff",
      "name": "Handoff",
      "version": "1.0.0",
      "bundleUrl": "https://github.com/bffless/apps/releases/download/handoff-v1.0.0/handoff-v1.0.0.bundle.zip",
      "sha256": "a029bdcfeaf75b4110284879189951eaa23cd4e1ad51eee23f938dcec100217b",
      "summary": "Share files, folders, and Sites with per-folder access control, share links, and live comments.",
      "description": "Handoff is an internal, permissioned file server that runs entirely on your BFFless project.\n\n## Highlights\n\n- Per-folder access control\n- Share links\n- Live Sites\n",
      "category": "files",
      "thumbnailUrl": "https://apps.bffless.dev/assets/handoff/thumbnail.png",
      "iconUrl": "https://apps.bffless.dev/assets/handoff/icon.png",
      "screenshots": [
        "https://apps.bffless.dev/assets/handoff/screenshots/01-folders.png"
      ],
      "docsUrl": "https://github.com/bffless/apps/blob/main/apps/handoff/bffless/README.md",
      "sourceUrl": "https://github.com/bffless/apps/tree/main/apps/handoff",
      "requires": { "presignedStorage": true, "ceMin": "0.3.15" }
    }
  ]
}
```

`store/src/pages/index.astro` (placeholder proving the loader works; replaced in Task 6):

```astro
---
import { loadRegistry } from '../lib/registry'
const { apps } = loadRegistry()
---
<html lang="en">
  <head><meta charset="utf-8" /><title>BFFless Apps</title></head>
  <body>
    <h1>BFFless Apps</h1>
    <ul>{apps.map((app) => <li>{app.name} v{app.version}</li>)}</ul>
  </body>
</html>
```

- [ ] **Step 4: Install and verify the build**

Run: `pnpm install` then `pnpm store:build`
Expected: `store/dist/index.html` exists and contains `Handoff v1.0.0`. Verify with `grep -o 'Handoff v1.0.0' store/dist/index.html`.

Also run `pnpm apps:check` — must still PASS (proves `store/` living outside `apps/` keeps conventions unaffected).

- [ ] **Step 5: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml .gitignore store
git commit -m "feat(store): scaffold Astro store package with typed registry loader

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Store pages — index, app detail, 404, OG meta

**Files:**
- Create: `store/src/layouts/Base.astro`
- Create: `store/src/components/AppCard.astro`
- Modify: `store/src/pages/index.astro` (replace placeholder)
- Create: `store/src/pages/apps/[id].astro`
- Create: `store/src/pages/404.astro`
- Create: `store/public/favicon.svg`, `store/public/logo.svg` (copied from `repos/assets`)

**Interfaces:**
- Consumes: `loadRegistry()`, `assetPath()`, `RegistryEntry` from Task 5.
- Produces: `store/dist/` with `index.html`, `apps/<id>/index.html` per registry entry, `404.html` — the shape Task 7's smoke assertions require.

- [ ] **Step 1: Copy brand assets**

```bash
cp /home/rico/bffless/repos/assets/favicon.svg store/public/favicon.svg
cp /home/rico/bffless/repos/assets/logo.svg store/public/logo.svg
```

- [ ] **Step 2: Base layout with OG meta**

`store/src/layouts/Base.astro`:

```astro
---
interface Props {
  title: string
  description: string
  /** Absolute URL for og:image (registry thumbnailUrl); falls back to the site logo. */
  ogImage?: string
}
const { title, description, ogImage } = Astro.props
const canonical = new URL(Astro.url.pathname, Astro.site)
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <title>{title}</title>
    <meta name="description" content={description} />
    <link rel="canonical" href={canonical} />
    <meta property="og:type" content="website" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonical} />
    {ogImage && <meta property="og:image" content={ogImage} />}
    {ogImage && <meta name="twitter:card" content="summary_large_image" />}
  </head>
  <body class="min-h-screen bg-zinc-50 text-zinc-900 antialiased">
    <header class="border-b border-zinc-200 bg-white">
      <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <a href="/" class="flex items-center gap-2 font-semibold">
          <img src="/logo.svg" alt="" class="h-7 w-7" />
          <span>BFFless Apps</span>
        </a>
        <nav class="flex items-center gap-4 text-sm text-zinc-600">
          <a href="https://docs.bffless.dev" class="hover:text-zinc-900">Docs</a>
          <a href="https://github.com/bffless/apps" class="hover:text-zinc-900">GitHub</a>
        </nav>
      </div>
    </header>
    <main class="mx-auto max-w-5xl px-4 py-10">
      <slot />
    </main>
    <footer class="border-t border-zinc-200 py-8 text-center text-sm text-zinc-500">
      Apps install in one click from Admin → Apps on any self-hosted
      <a href="https://docs.bffless.dev" class="underline hover:text-zinc-700">BFFless CE</a> ≥ 0.4.0 instance.
    </footer>
  </body>
</html>
```

- [ ] **Step 3: App card + index page**

`store/src/components/AppCard.astro`:

```astro
---
import type { RegistryEntry } from '../lib/registry'
import { assetPath } from '../lib/registry'
interface Props {
  app: RegistryEntry
}
const { app } = Astro.props
const thumb = assetPath(app.thumbnailUrl)
---
<a
  href={`/apps/${app.id}/`}
  class="group overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition hover:shadow-md"
>
  <div class="aspect-[1200/630] bg-zinc-100">
    {
      thumb ? (
        <img src={thumb} alt={`${app.name ?? app.id} screenshot`} class="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div class="flex h-full items-center justify-center text-4xl font-bold text-zinc-300">
          {(app.name ?? app.id).slice(0, 1)}
        </div>
      )
    }
  </div>
  <div class="p-4">
    <div class="flex items-center justify-between gap-2">
      <h2 class="font-semibold group-hover:underline">{app.name ?? app.id}</h2>
      <span class="shrink-0 text-xs text-zinc-400">v{app.version}</span>
    </div>
    {app.category && <span class="mt-1 inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">{app.category}</span>}
    {app.summary && <p class="mt-2 text-sm text-zinc-600">{app.summary}</p>}
  </div>
</a>
```

`store/src/pages/index.astro`:

```astro
---
import Base from '../layouts/Base.astro'
import AppCard from '../components/AppCard.astro'
import { loadRegistry } from '../lib/registry'
const { apps } = loadRegistry()
---
<Base
  title="BFFless Apps — one-click apps for your own instance"
  description="Open-source apps that run entirely on your self-hosted BFFless instance. Install any of them in one click from Admin → Apps."
>
  <div class="mb-10 max-w-2xl">
    <h1 class="text-3xl font-bold tracking-tight">Apps for your BFFless instance</h1>
    <p class="mt-3 text-zinc-600">
      Every app here is open source and runs entirely on <em>your</em> self-hosted BFFless project —
      its backend is a reviewable pipeline rule set, not someone else's server. Install in one click
      from <strong>Admin → Apps</strong> on CE ≥ 0.4.0.
    </p>
  </div>
  <div class="grid gap-6 sm:grid-cols-2">
    {apps.map((app) => <AppCard app={app} />)}
  </div>
</Base>
```

- [ ] **Step 4: Detail page and 404**

`store/src/pages/apps/[id].astro`:

```astro
---
import { marked } from 'marked'
import Base from '../../layouts/Base.astro'
import { loadRegistry, assetPath } from '../../lib/registry'
import type { RegistryEntry } from '../../lib/registry'

export function getStaticPaths() {
  return loadRegistry().apps.map((app) => ({ params: { id: app.id }, props: { app } }))
}

interface Props {
  app: RegistryEntry
}
const { app } = Astro.props
const name = app.name ?? app.id
const descriptionHtml = app.description ? marked.parse(app.description) : null
const screenshots = (app.screenshots ?? []).map(assetPath)
const icon = assetPath(app.iconUrl)
---
<Base
  title={`${name} — BFFless Apps`}
  description={app.summary ?? `${name} on the BFFless app catalog`}
  ogImage={app.thumbnailUrl}
>
  <article>
    <header class="flex items-start gap-4">
      {icon && <img src={icon} alt="" class="h-14 w-14 rounded-xl border border-zinc-200 bg-white p-1" />}
      <div>
        <h1 class="text-3xl font-bold tracking-tight">{name}</h1>
        <p class="mt-1 text-zinc-600">{app.summary}</p>
        <div class="mt-2 flex flex-wrap items-center gap-3 text-sm text-zinc-500">
          <span>v{app.version}</span>
          {app.category && <span class="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">{app.category}</span>}
          {app.requires?.ceMin && <span>requires CE ≥ {app.requires.ceMin}</span>}
          {app.requires?.presignedStorage && <span>needs presigned-upload storage</span>}
        </div>
      </div>
    </header>

    <section class="mt-8 rounded-xl border border-zinc-200 bg-white p-5">
      <h2 class="font-semibold">Install</h2>
      <ol class="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-700">
        <li>Open <strong>Admin → Apps</strong> on your self-hosted BFFless CE instance (v0.4.0 or newer).</li>
        <li>Pick <strong>{name}</strong> and click <strong>Install</strong> — the bundle is fetched, checksum-verified, and set up end to end.</li>
      </ol>
      <p class="mt-3 text-sm text-zinc-500">
        No BFFless instance yet? <a href="https://docs.bffless.dev" class="underline hover:text-zinc-700">Self-host CE</a> first —
        or <a href={app.sourceUrl} class="underline hover:text-zinc-700">fork the source</a> and deploy it yourself.
      </p>
    </section>

    {
      screenshots.length > 0 && (
        <section class="mt-8">
          <h2 class="sr-only">Screenshots</h2>
          <div class="grid gap-4 sm:grid-cols-2">
            {screenshots.map((src) => (
              <img src={src} alt={`${name} screenshot`} class="rounded-xl border border-zinc-200" loading="lazy" />
            ))}
          </div>
        </section>
      )
    }

    {
      descriptionHtml && (
        <section class="prose-custom mt-8 max-w-none" set:html={descriptionHtml} />
      )
    }

    <section class="mt-8 flex flex-wrap gap-4 text-sm">
      {app.docsUrl && <a href={app.docsUrl} class="underline hover:text-zinc-700">Documentation</a>}
      {app.sourceUrl && <a href={app.sourceUrl} class="underline hover:text-zinc-700">Source code</a>}
    </section>
  </article>
</Base>

<style is:global>
  .prose-custom h1, .prose-custom h2 { font-weight: 600; margin: 1.5rem 0 0.5rem; }
  .prose-custom h1 { font-size: 1.5rem; }
  .prose-custom h2 { font-size: 1.25rem; }
  .prose-custom p, .prose-custom li { color: rgb(63 63 70); line-height: 1.65; margin: 0.5rem 0; }
  .prose-custom ul { list-style: disc; padding-left: 1.25rem; }
  .prose-custom strong { color: rgb(24 24 27); }
  .prose-custom a { text-decoration: underline; }
</style>
```

(Description markdown is first-party content from this repo — CI-built, PR-reviewed — so no HTML sanitizer; note this in a code comment if you prefer.)

`store/src/pages/404.astro`:

```astro
---
import Base from '../layouts/Base.astro'
---
<Base title="Not found — BFFless Apps" description="This page does not exist.">
  <div class="py-16 text-center">
    <h1 class="text-3xl font-bold">404</h1>
    <p class="mt-2 text-zinc-600">That page doesn't exist. <a href="/" class="underline">Browse the apps</a>.</p>
  </div>
</Base>
```

- [ ] **Step 5: Build and verify structure**

Run: `pnpm store:build`
Expected: `store/dist/index.html`, `store/dist/apps/handoff/index.html`, `store/dist/404.html` all exist. `grep -o 'og:image' store/dist/apps/handoff/index.html` finds the meta tag.

- [ ] **Step 6: Visual check with the headless browser**

```bash
pnpm store:dev &
sleep 6
cd /home/rico/bffless/localdev-tools
node shot.mjs "http://localhost:4321/" --out /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/store-index.png --full
node shot.mjs "http://localhost:4321/apps/handoff/" --out /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/store-detail.png --full
```

READ both screenshots. Dev-fixture asset paths (`/assets/handoff/…`) 404 in plain dev until `pnpm store:assets` (Task 7) is run — the placeholder-initial card is the expected fallback for the thumbnail here; that's the missing-asset degradation path working, not a bug. Layout, typography, header/footer must look right; console errors from the missing assets are acceptable in this specific check, other console errors are not.

- [ ] **Step 7: Commit**

```bash
git add store
git commit -m "feat(store): index, app detail, and 404 pages with OG meta

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `scripts/build-store-artifact.mjs` — composite artifact orchestrator

**Files:**
- Create: `scripts/build-store-artifact.mjs`

**Interfaces:**
- Consumes: `buildRegistry` (Task 1), the `store` package build (Tasks 5–6), `apps/<app>/catalog/` dirs (Task 3).
- Produces: `registry-staging/` = site pages at root + `registry.json` + `assets/<app>/…`; exits non-zero if smoke assertions fail. The output dir is named `registry-staging` (not `store-dist`) because upload-artifact prefixes every zip entry with the `path` input and CE serves by matching the domain mapping's path against those publicPaths — the live `apps.bffless.dev` mapping's path is `/registry-staging`, so this name is load-bearing (see Step 1 comment). CLI: `node scripts/build-store-artifact.mjs [--sidecars dist-bundles] [--out registry-staging] [--stage-only]`. Both Task 8 workflows run it; `pnpm store:assets` (`--stage-only`) populates `store/public/assets/` for local dev.

- [ ] **Step 1: Write the orchestrator**

```js
#!/usr/bin/env node
// Builds the composite apps.bffless.dev artifact: store site pages at the root,
// registry.json, and assets/<app>/** (each published app's catalog content). Published
// by app-bundles.yml (after an app release) and deploy-store.yml (on store/metadata
// changes) to the app-registry alias — one artifact, so the site, registry, and assets
// can never be deployed out of sync (deployments merge per commit SHA, so two
// independent workflows cannot co-write one alias).
//
// CLI: node scripts/build-store-artifact.mjs [--sidecars dist-bundles] [--out registry-staging] [--stage-only]
//   --stage-only: build registry + stage store/public/assets, skip the site build
//                 (local dev helper: pnpm store:assets)
// Env: GITHUB_REPOSITORY (required), ASSET_BASE_URL (optional, see build-registry.mjs).

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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
const outDir = resolve(repoRoot, opt('--out', 'registry-staging'))
const stageOnly = args.includes('--stage-only')

function fail(message) {
  console.error(`build-store-artifact: ${message}`)
  process.exit(1)
}

const repo = process.env.GITHUB_REPOSITORY
if (!repo) fail('GITHUB_REPOSITORY env var is required')

// 1. Registry (omission warnings are emitted by the shared builder's CLI path; here we
// re-emit them ourselves so both entry points behave identically).
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

// 4. Assemble the artifact: site + registry.json at the root. The output dir is named
// registry-staging — not a build label — because upload-artifact prefixes every zip entry with
// the literal `path` input and CE stores those entry names verbatim as each file's publicPath,
// matched against the domain mapping's path at serve time. The live apps.bffless.dev domain
// mapping has path /registry-staging, so this name must stay registry-staging to keep every
// publicPath matching what's already being served — renaming it breaks the live site.
rmSync(outDir, { recursive: true, force: true })
cpSync(join(repoRoot, 'store', 'dist'), outDir, { recursive: true })
writeFileSync(join(outDir, 'registry.json'), registryJson)

// 5. Smoke assertions — fail loudly rather than deploy a structurally broken artifact.
const mustExist = ['index.html', '404.html', 'registry.json']
for (const entry of registry.apps) {
  mustExist.push(join('apps', entry.id, 'index.html'))
  mustExist.push(join('assets', entry.id, 'thumbnail.png'))
}
const missing = mustExist.filter((rel) => !existsSync(join(outDir, rel)))
if (missing.length > 0) fail(`artifact is missing: ${missing.join(', ')}`)

const published = JSON.parse(readFileSync(join(outDir, 'registry.json'), 'utf8'))
if (published.schemaVersion !== 1) fail('registry.json schemaVersion must be 1')

console.log(`\nBuilt ${outDir}: ${registry.apps.length} app(s), ${omitted.length} omitted.`)
```

- [ ] **Step 2: Run end-to-end locally**

Using the real sidecar fetched in Task 2:

```bash
node scripts/fetch-sidecars.mjs --sidecars dist-bundles
GITHUB_REPOSITORY=bffless/apps node scripts/build-store-artifact.mjs
```

Expected: exits 0; `registry-staging/` contains `index.html`, `apps/handoff/index.html`, `registry.json`, `assets/handoff/thumbnail.png`, `assets/handoff/screenshots/…`, and NO nested `registry-staging/registry-staging/`. Inspect `registry-staging/registry.json` — the handoff entry carries the new metadata fields and the same `sha256` as the live registry.

- [ ] **Step 3: Verify the smoke assertions actually fire**

Run: `mv apps/handoff/catalog/thumbnail.png /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/ && GITHUB_REPOSITORY=bffless/apps node scripts/build-store-artifact.mjs; echo "exit=$?"`
Expected: `exit=1` with `artifact is missing: assets/handoff/thumbnail.png`. Restore the file, re-run, confirm exit 0.

- [ ] **Step 4: Visual check of the real artifact**

```bash
cd registry-staging && python3 -m http.server 8899 &
cd /home/rico/bffless/localdev-tools
node shot.mjs "http://localhost:8899/" --out /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/artifact-index.png --full
node shot.mjs "http://localhost:8899/apps/handoff/" --out /tmp/claude-1000/-home-rico-bffless/a37a4778-9fbd-4228-b581-4ac39c3dea11/scratchpad/artifact-detail.png --full
```

READ both — this time the real Handoff thumbnail and screenshots must render (assets are in the artifact). Kill the server. `shot.mjs` exits non-zero on console errors / failed requests — it must exit 0 here.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-store-artifact.mjs
git commit -m "feat: composite store artifact builder (site + registry.json + assets)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Workflows — rewire `app-bundles.yml`, add `deploy-store.yml`

**Files:**
- Modify: `.github/workflows/app-bundles.yml`
- Create: `.github/workflows/deploy-store.yml`

**Interfaces:**
- Consumes: `scripts/fetch-sidecars.mjs`, `scripts/build-store-artifact.mjs`.
- Produces: both workflows publish `registry-staging/` to alias `app-registry` at `vars.BFFLESS_REGISTRY_URL` with `secrets.BFFLESS_REGISTRY_API_KEY`, serialized under the `app-bundles` concurrency group.

- [ ] **Step 1: Rewire `app-bundles.yml`**

Replace the three steps `Fetch sha256 sidecars for other published apps`, `Build registry.json`, and `Publish registry.json to BFFless` with:

```yaml
      # The registry lists every app that has ever been published — fetch the other apps'
      # sidecars (best effort; a manifest with no release yet is omitted with a warning).
      - name: Fetch sha256 sidecars for other published apps
        env:
          GH_TOKEN: ${{ github.token }}
        run: node scripts/fetch-sidecars.mjs --sidecars dist-bundles

      # One composite artifact: store site + registry.json + assets. See
      # scripts/build-store-artifact.mjs and docs/superpowers/specs/2026-08-01-app-store-frontend-design.md.
      # Trade-off: this run builds the composite from the tag's commit, which may be older than
      # main — any site/catalog changes made on main since the tag would be temporarily reverted
      # by this deploy, until the next deploy-store push run on main rebuilds from HEAD. Accepted:
      # self-heals on the next store-path push to main.
      - name: Build store artifact (site + registry.json + assets)
        run: node scripts/build-store-artifact.mjs --sidecars dist-bundles --out registry-staging

      # Publishes to the app-registry alias on the bffless.dev instance (deliberately NOT
      # the demo instance, so resetting the demo box can never take the catalog down).
      - name: Publish store + registry to BFFless
        uses: bffless/upload-artifact@v1
        with:
          path: registry-staging
          api-url: ${{ vars.BFFLESS_REGISTRY_URL }}
          api-key: ${{ secrets.BFFLESS_REGISTRY_API_KEY }}
          alias: app-registry
          description: 'App store + catalog registry'
```

Also update the header comment block: the workflow now publishes the store site alongside `registry.json`, and the operator caveat about mapping `apps.bffless.dev` gains: the artifact dir name (`registry-staging`) must stay in sync with the live domain mapping's path, since upload-artifact prefixes every zip entry with it and CE matches publicPaths against that path.

- [ ] **Step 2: Create `deploy-store.yml`**

```yaml
name: Store — build + deploy apps.bffless.dev

# Rebuilds the composite store artifact (site + registry.json + assets — see
# scripts/build-store-artifact.mjs) when store/metadata sources change, and deploys it on
# main. app-bundles.yml publishes the same artifact after an app release; the shared
# `app-bundles` concurrency group serializes the two so they can't race on the alias.
#
# On pull_request this builds (and smoke-asserts) without deploying — the CI check for
# store changes.

on:
  push:
    branches: [main]
    paths:
      - 'store/**'
      - 'apps/*/catalog/**'
      - 'apps/*/bffless-app.json'
      - 'scripts/build-registry.mjs'
      - 'scripts/build-store-artifact.mjs'
      - 'scripts/fetch-sidecars.mjs'
      - '.github/workflows/deploy-store.yml'
  pull_request:
    paths:
      - 'store/**'
      - 'apps/*/catalog/**'
      - 'apps/*/bffless-app.json'
      - 'scripts/build-registry.mjs'
      - 'scripts/build-store-artifact.mjs'
      - 'scripts/fetch-sidecars.mjs'
      - '.github/workflows/deploy-store.yml'

permissions:
  contents: read

concurrency:
  group: ${{ github.event_name == 'push' && 'app-bundles' || format('store-pr-{0}', github.event.pull_request.number) }}
  cancel-in-progress: ${{ github.event_name != 'push' }}

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Script tests
        run: pnpm scripts:test

      - name: Fetch published sha256 sidecars
        env:
          GH_TOKEN: ${{ github.token }}
        run: node scripts/fetch-sidecars.mjs --sidecars dist-bundles

      - name: Build store artifact (site + registry.json + assets)
        run: node scripts/build-store-artifact.mjs --sidecars dist-bundles --out registry-staging

      - name: Deploy to apps.bffless.dev
        if: github.event_name == 'push'
        uses: bffless/upload-artifact@v1
        with:
          path: registry-staging
          api-url: ${{ vars.BFFLESS_REGISTRY_URL }}
          api-key: ${{ secrets.BFFLESS_REGISTRY_API_KEY }}
          alias: app-registry
          description: 'App store + catalog registry'
```

- [ ] **Step 3: Validate the YAML**

Run: `npx --yes js-yaml .github/workflows/deploy-store.yml > /dev/null && npx --yes js-yaml .github/workflows/app-bundles.yml > /dev/null && echo OK`
Expected: `OK` (both parse). Also re-run the full local pipeline once more (`node scripts/fetch-sidecars.mjs --sidecars dist-bundles && GITHUB_REPOSITORY=bffless/apps node scripts/build-store-artifact.mjs`) to confirm nothing in the workflow rewiring broke the scripts.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/app-bundles.yml .github/workflows/deploy-store.yml
git commit -m "ci: publish the store site with registry.json; add deploy-store workflow

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: PR, rollout, and post-deploy verification

**Files:** none (operational task)

**Interfaces:**
- Consumes: everything above, merged; MCP tools on the bffless.dev instance (`mcp__bffless-dev__*`).
- Produces: the live store at `https://apps.bffless.dev/`, unchanged-URL registry, cache rules, a CE follow-up issue.

- [ ] **Step 1: Open the PR**

```bash
git push -u origin store-frontend
gh pr create --repo bffless/apps --title "feat: app store frontend for apps.bffless.dev" --body-file - <<'EOF'
## Summary
- Static store site (Astro 5 + Tailwind) showcasing registry.json apps at apps.bffless.dev
- New per-app metadata convention: apps/<app>/catalog/ (description.md, thumbnail.png, icon.png, screenshots/) folded into registry.json as description/category/thumbnailUrl/iconUrl/screenshots — usable by any registry consumer incl. CE Admin → Apps
- Registry builder extracted from app-bundles.yml into tested scripts/build-registry.mjs; composite artifact (site + registry.json + assets) built by scripts/build-store-artifact.mjs and published by both app-bundles.yml and the new deploy-store.yml
- Handoff catalog content authored (first store entry)

Design: docs/superpowers/specs/2026-08-01-app-store-frontend-design.md

## Rollout (after merge — operator)
- [ ] deploy-store.yml runs on merge and publishes the composite artifact — the artifact dir (and
      every publicPath in it) is named `registry-staging` to match the live domain mapping's
      existing path, so the site + registry.json + assets all serve immediately with no domain
      change and no 404 window
- [ ] add cache rules: ~1h /registry.json, 24h /assets/*
- [ ] verify https://apps.bffless.dev/ and /registry.json; verify a CE instance still lists Handoff in Admin → Apps

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

**PAUSE: the user reviews and merges the PR.** Do not merge it yourself.

- [ ] **Step 2 (after merge): watch the first deploy**

`gh run watch` the `deploy-store.yml` run on main (or `gh run list --repo bffless/apps --workflow deploy-store.yml`). Confirm success, then: `curl -s https://apps.bffless.dev/registry.json | head -30` — must return the registry with no domain change required (the artifact's publicPaths already match the live domain mapping's `/registry-staging` path).

- [ ] **Step 3: Add cache rules (MCP, bffless-dev instance)**

- `mcp__bffless-dev__create_cache_rule` on project `8d14ae31-a9f5-4620-9ee7-d0f147a6f6ae` (bffless/apps): pattern `/registry.json`, max-age ~3600.
- `mcp__bffless-dev__create_cache_rule`: pattern `/assets/*`, max-age ~86400.

(Check the tool's exact parameter names with ToolSearch before calling; the cache-rule shape wasn't inspected during planning.)

- [ ] **Step 4: Post-deploy verification**

```bash
curl -s https://apps.bffless.dev/registry.json | python3 -m json.tool | head -40   # registry intact + new fields
curl -s -o /dev/null -w "%{http_code}\n" https://apps.bffless.dev/               # 200
curl -s -o /dev/null -w "%{http_code}\n" https://apps.bffless.dev/apps/handoff/  # 200
curl -s -o /dev/null -w "%{http_code}\n" https://apps.bffless.dev/assets/handoff/thumbnail.png  # 200
```

Then screenshot the live site with `shot.mjs` and READ it. Finally verify CE compatibility: any live CE ≥ 0.4.0 instance's Admin → Apps still lists Handoff (per the app-catalog memory, the j5s.dev demo or the droplet used for v0.4.0 testing).

- [ ] **Step 5: File the CE follow-up issue**

```bash
gh issue create --repo bffless/ce --title "app-catalog: render thumbnailUrl/description from registry entries in Admin → Apps" --body-file - <<'EOF'
registry.json entries now carry `description` (markdown), `category`, `thumbnailUrl`, and `screenshots[]` (absolute https://apps.bffless.dev/assets/<app>/… URLs) — added by bffless/apps for the apps.bffless.dev store. `validateRegistry` already tolerates them (additive, schemaVersion 1).

Admin → Apps could render the thumbnail on each catalog card and the description in the app detail/install view. Source of truth: apps/<app>/catalog/ in bffless/apps, folded in by scripts/build-registry.mjs.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## Self-Review Notes

- **Spec coverage:** §1 store site → Tasks 5–6; §2 catalog convention → Tasks 3–4; §3 registry extension → Task 1; §4 pipeline → Tasks 1, 2, 7, 8; §5 serving changes → Task 9; §6 edge cases → Task 1 (omission warnings, missing-catalog tolerance), Task 6 (placeholder card), Task 7 (the composite output dir is named `registry-staging` to match the live domain mapping's path — an addition beyond the spec, noted in the PR body); §7 testing → Tasks 1 (unit), 7 (smoke + E2E + visual), 9 (post-deploy).
- **Deviation from spec, deliberate:** the spec's rollout said "update the domain path"; in practice no domain-path change is needed at all — naming the composite artifact's output dir `registry-staging` (matching upload-artifact's zip-entry-prefix behavior to the live domain mapping's existing path) makes every publicPath in the artifact serve correctly from the first deploy, with zero operator action and zero 404 window.
- **Type consistency:** `RegistryEntry` fields in `store/src/lib/registry.ts` (Task 5) match the entry object built in `build-registry.mjs` (Task 1); `assetPath`/`loadRegistry` names match across Tasks 5–6; `--sidecars`/`--out`/`--stage-only` flags match across Tasks 2, 7, 8; alias `app-registry` + vars `BFFLESS_REGISTRY_URL`/`BFFLESS_REGISTRY_API_KEY` match the live workflow.
