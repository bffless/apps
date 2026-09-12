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

test('on.manual.warnings: a list of { if, message }; anything else is a schema error (01)', () => {
  const ok = validateDefinition({
    name: 'x',
    on: { manual: { inputs: { n: { type: 'number' } }, warnings: [{ if: '${{ inputs.n > 1 }}', message: 'big' }] } },
    jobs: { a: minimalJob },
  })
  expect(ok).toEqual([])

  const missing = validateDefinition({
    name: 'x',
    on: { manual: { warnings: [{ message: 'no if' }] } },
    jobs: { a: minimalJob },
  })
  expect(missing).toHaveLength(1)
  expect(missing[0]!.path).toBe('/on/manual/warnings/0')
  expect(missing[0]!.message).toMatch(/if/)

  const extra = validateDefinition({
    name: 'x',
    on: { manual: { warnings: [{ if: 'true', message: 'm', level: 'error' }] } },
    jobs: { a: minimalJob },
  })
  expect(extra).toHaveLength(1)
  expect(extra[0]!.message).toMatch(/level/)
})

// `keep:` (05 Retention, apps#686) is a top-level key with its own grammar —
// `^[1-9][0-9]*(h|d)$` — deliberately separate from `$defs/duration` (`ms|s|m|h`),
// so a run's retention reads in whole hours or days, never zero (a run must not be
// born expired), and a `retry.delay: 30d` stays invalid.
test.each(['30d', '12h', '1h', '365d'])('keep: %s passes at the top level', (keep) => {
  expect(validateDefinition({ name: 'x', keep, on: { manual: {} }, jobs: { a: minimalJob } })).toEqual([])
})

test.each(['0d', '0h', '030d', '30m', '30', '30ms', '1d12h', 'd', ''])('keep: %j is a schema error at the document root', (keep) => {
  const f = validateDefinition({ name: 'x', keep, on: { manual: {} }, jobs: { a: minimalJob } })
  expect(f).toHaveLength(1)
  expect(f[0]!.rule).toBe('schema')
  expect(f[0]!.path).toBe('/keep')
})

test('keep: under a job is a schema error — it is a workflow key, not a job key', () => {
  const f = validateDefinition({
    name: 'x',
    on: { manual: {} },
    jobs: { a: { ...minimalJob, keep: '30d' } },
  })
  expect(f).toHaveLength(1)
  expect(f[0]!.rule).toBe('schema')
  expect(f[0]!.path).toBe('/jobs/a')
  expect(f[0]!.message).toMatch(/keep/)
})

test('a duration is not a keep: retry.delay: 30d is still refused', () => {
  const f = validateDefinition({
    name: 'x',
    on: { manual: {} },
    jobs: { a: { steps: [{ ...minimalJob.steps[0], retry: { max: 1, delay: '30d' } }] } },
  })
  expect(f.length).toBeGreaterThanOrEqual(1)
  expect(f.some((x) => x.rule === 'schema' && /delay/.test(x.path))).toBe(true)
})
