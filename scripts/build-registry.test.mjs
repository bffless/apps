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
function makeFixture({
  id = 'demo',
  version = '1.0.0',
  manifestExtra = {},
  catalog = null,
  sidecar = true,
  commit = null,
} = {}) {
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
  if (commit) {
    writeFileSync(join(sidecarsDir, `${id}-v${version}.bundle.commit`), commit)
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

const COMMIT = 'c01bb08a1b2c3d4e5f60718293a4b5c6d7e8f900'

test('stamps commit from the .commit sidecar and releaseTag from id+version', () => {
  const { appsDir, sidecarsDir } = makeFixture({ commit: `${COMMIT}\n` })
  const entry = buildRegistry({ appsDir, sidecarsDir, assetBaseUrl: ASSET_BASE, repo: REPO }).registry.apps[0]
  assert.equal(entry.commit, COMMIT)
  assert.equal(entry.releaseTag, 'demo-v1.0.0')
})

// A release cut before bffless/apps#276 has no .commit asset. The entry must still build, and
// must carry no `commit` at all rather than an empty string — CE tests for absence to decide
// whether to fall back to the bundle hash.
test('omits commit when the sidecar is absent, but still sets releaseTag', () => {
  const { appsDir, sidecarsDir } = makeFixture()
  const entry = buildRegistry({ appsDir, sidecarsDir, assetBaseUrl: ASSET_BASE, repo: REPO }).registry.apps[0]
  assert.equal(entry.commit, undefined)
  assert.equal(entry.releaseTag, 'demo-v1.0.0')
})

// Guards against a truncated/garbled sidecar reaching registry.json as a plausible-looking
// value: anything that is not a bare 40-hex sha is dropped, not passed through.
test('ignores a malformed .commit sidecar rather than emitting a bad commit', () => {
  for (const bad of ['not-a-sha\n', 'c01bb08\n', '', `${COMMIT} extra\n`]) {
    const { appsDir, sidecarsDir } = makeFixture({ commit: bad })
    const entry = buildRegistry({ appsDir, sidecarsDir, assetBaseUrl: ASSET_BASE, repo: REPO }).registry.apps[0]
    assert.equal(entry.commit, undefined, `expected no commit for sidecar ${JSON.stringify(bad)}`)
  }
})

test('an app without catalog/ still gets an entry, with metadata fields absent', () => {
  const { appsDir, sidecarsDir } = makeFixture()
  const entry = buildRegistry({ appsDir, sidecarsDir, assetBaseUrl: ASSET_BASE, repo: REPO }).registry.apps[0]
  assert.equal(entry.description, undefined)
  assert.equal(entry.thumbnailUrl, undefined)
  assert.equal(entry.screenshots, undefined)
})
