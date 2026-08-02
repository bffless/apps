import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkManualSteps } from './check-app-conventions.mjs'

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
