import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkManualSteps, checkReleaseComponents } from './check-app-conventions.mjs'

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
