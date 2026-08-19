import { test, expect } from 'vitest'
import { validateDefinition } from '../src/schema/validate.js'

const minimalJob = { steps: [{ id: 's', uses: 'pipeline', with: { path: 'echo' } }] }

test('minimal valid workflow passes', () => {
  expect(validateDefinition({ name: 'x', on: { manual: {} }, jobs: { a: minimalJob } })).toEqual([])
})

test('missing name is a schema error at the document root', () => {
  const f = validateDefinition({ on: { manual: {} }, jobs: { a: minimalJob } })
  expect(f).toHaveLength(1)
  expect(f[0]!.rule).toBe('schema')
  expect(f[0]!.path).toBe('')
  expect(f[0]!.message).toMatch(/name/)
})

test('bad step reports against its own kind, not the oneOf storm', () => {
  const f = validateDefinition({
    name: 'x',
    on: { manual: {} },
    jobs: { a: { steps: [{ id: 's', uses: 'pipeline' }] } },
  })
  expect(f.length).toBeLessThan(4)
  expect(f.some((x) => /with/.test(x.message))).toBe(true)
})

test('unknown uses is a single clear error', () => {
  const f = validateDefinition({
    name: 'x',
    on: { manual: {} },
    jobs: { a: { steps: [{ id: 's', uses: 'shell' }] } },
  })
  expect(f).toHaveLength(1)
  expect(f[0]!.message).toMatch(/pipeline, island, form, script/)
  expect(f[0]!.path).toBe('/jobs/a/steps/0')
})

test('bad identifier and bad duration are caught', () => {
  const f = validateDefinition({
    name: 'x',
    on: { manual: { inputs: { BadName: { type: 'string' } } } },
    jobs: {
      a: { steps: [{ id: 's', uses: 'pipeline', with: { path: 'e' }, retry: { max: 1, delay: '5 sec' } }] },
    },
  })
  expect(f.length).toBeGreaterThanOrEqual(2)
})

test('non-object document is one error', () => {
  const f = validateDefinition('just a string')
  expect(f.length).toBeGreaterThanOrEqual(1)
  expect(f[0]!.rule).toBe('schema')
})

test('island step missing outputs is caught against its branch', () => {
  const f = validateDefinition({
    name: 'x',
    on: { manual: {} },
    jobs: { a: { steps: [{ id: 's', uses: 'island', with: { src: 'islands/x.html' } }] } },
  })
  expect(f.some((x) => /outputs/.test(x.message))).toBe(true)
})
