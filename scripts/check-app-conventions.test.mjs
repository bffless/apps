import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkManualSteps, checkReleaseComponents, checkVersionParity } from './check-app-conventions.mjs'

const REL = 'apps/demo/bffless-app.json'

function manifestWith(steps) {
  return { install: { manualSteps: steps } }
}

test('accepts a short note', () => {
  const errors = checkManualSteps(
    manifestWith([{ id: 'a', title: 'Do the thing', body: 'Short and plain.' }]),
    REL,
  )
  assert.deepEqual(errors, [])
})

test('rejects a body over 220 characters', () => {
  const errors = checkManualSteps(
    manifestWith([{ id: 'a', title: 'T', body: 'x'.repeat(221) }]),
    REL,
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0], /install\.manualSteps\[0\]\.body/)
  assert.match(errors[0], /221 characters/)
  assert.match(errors[0], /220/)
})

test('rejects an unknown placeholder', () => {
  const errors = checkManualSteps(
    manifestWith([{ id: 'a', title: 'T', body: 'Go to {foo}.' }]),
    REL,
  )
  assert.equal(errors.length, 1)
  assert.match(errors[0], /unknown placeholder \{foo\}/)
})

test('accepts the known placeholders', () => {
  const errors = checkManualSteps(
    manifestWith([
      {
        id: 'a',
        title: 'T',
        body: 'Allow PUT from {appHost}.',
        deepLink: '/repo/{projectPath}/settings?tab=members',
      },
    ]),
    REL,
  )
  assert.deepEqual(errors, [])
})

test('accepts a manifest with no manual steps', () => {
  assert.deepEqual(checkManualSteps({ install: {} }, REL), [])
})

const CONFIG = {
  packages: {
    'apps/reader': { component: 'reader', 'include-component-in-tag': true },
    'apps/handoff': { component: 'handoff', 'include-component-in-tag': true },
  },
}
const MANIFEST = { 'apps/reader': '1.0.1', 'apps/handoff': '1.0.2' }

test('accepts a config whose components match the catalog apps', () => {
  assert.deepEqual(checkReleaseComponents(CONFIG, ['reader', 'handoff'], MANIFEST), [])
})

test('rejects a catalog app with no release-please component', () => {
  const errors = checkReleaseComponents(CONFIG, ['reader', 'handoff', 'notes'], {
    ...MANIFEST,
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /apps\/notes/)
  assert.match(errors[0], /release-please-config\.json/)
})

test('rejects a component for an app that ships no manifest', () => {
  const config = {
    packages: { ...CONFIG.packages, 'apps/studio': { component: 'studio' } },
  }
  const errors = checkReleaseComponents(config, ['reader', 'handoff'], MANIFEST)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /apps\/studio/)
})

test('rejects a component missing from .release-please-manifest.json', () => {
  const errors = checkReleaseComponents(CONFIG, ['reader', 'handoff'], {
    'apps/reader': '1.0.1',
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /apps\/handoff/)
  assert.match(errors[0], /release-please-manifest/)
})

// release-please also owns the publishable packages/* components (workflow-lint,
// workflow-script). Those ship no bffless-app.json and never appear in the catalog, so
// this check must stay blind to them — otherwise publishing a package would fail
// `pnpm apps:check` on every run.
test('ignores a packages/* component that ships no bffless-app.json', () => {
  const config = {
    packages: {
      ...CONFIG.packages,
      'packages/workflow-lint': { component: 'workflow-lint', 'include-component-in-tag': true },
    },
  }
  const manifest = { ...MANIFEST, 'packages/workflow-lint': '0.1.0' }
  assert.deepEqual(checkReleaseComponents(config, ['reader', 'handoff'], manifest), [])
})

test('rejects a component whose tag would not match <app>-v<version>', () => {
  const config = {
    packages: {
      'apps/reader': { component: 'rivulet', 'include-component-in-tag': true },
      'apps/handoff': { component: 'handoff', 'include-component-in-tag': true },
    },
  }
  const errors = checkReleaseComponents(config, ['reader', 'handoff'], MANIFEST)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /rivulet/)
})

// checkVersionParity: package.json, bffless-app.json and .release-please-manifest.json are
// all written in one release-please commit; if the extra-files path in
// release-please-config.json resolved wrong, bffless-app.json (the number the catalog
// actually reads) would silently lag the tag — a direct generalisation of the incident
// this branch exists to fix.
test('accepts versions that agree across package.json, bffless-app.json and the manifest', () => {
  const errors = checkVersionParity(['reader', 'handoff'], {
    reader: { packageJson: '1.0.1', manifest: '1.0.1', releaseManifest: '1.0.1' },
    handoff: { packageJson: '1.0.2', manifest: '1.0.2', releaseManifest: '1.0.2' },
  })
  assert.deepEqual(errors, [])
})

test('rejects package.json ahead of the release-please manifest', () => {
  const errors = checkVersionParity(['reader'], {
    reader: { packageJson: '1.1.0', manifest: '1.0.1', releaseManifest: '1.0.1' },
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /reader/)
})

test('rejects bffless-app.json behind package.json and the release-please manifest', () => {
  const errors = checkVersionParity(['handoff'], {
    handoff: { packageJson: '1.1.0', manifest: '1.0.2', releaseManifest: '1.1.0' },
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /handoff/)
})
