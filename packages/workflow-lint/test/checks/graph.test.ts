import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { checkIds } from '../../src/checks/ids.js'
import { checkGraph } from '../../src/checks/graph.js'

const def = (yaml: string) => toDefinition(loadYaml(yaml).data)

const step = (id: string) => `{ id: ${id}, uses: pipeline, with: { path: e } }`

test('duplicate step id within a job is an error', () => {
  const d = def(`
name: x
on: { manual: {} }
jobs:
  a:
    steps: [${step('one')}, ${step('one')}]
`)
  const f = checkIds(d)
  expect(f).toHaveLength(1)
  expect(f[0]).toMatchObject({ rule: 'duplicate-step-id', severity: 'error', path: '/jobs/a/steps/1/id' })
})

test('same step id in different jobs is fine', () => {
  const d = def(`
name: x
on: { manual: {} }
jobs:
  a: { steps: [${step('one')}] }
  b: { steps: [${step('one')}] }
`)
  expect(checkIds(d)).toEqual([])
})

test('needs referencing a nonexistent job is an error', () => {
  const d = def(`
name: x
on: { manual: {} }
jobs:
  a: { needs: ghost, steps: [${step('s')}] }
`)
  const f = checkGraph(d)
  expect(f).toHaveLength(1)
  expect(f[0]).toMatchObject({ rule: 'needs-unknown', severity: 'error' })
})

test('a needs cycle is reported once, naming the cycle', () => {
  const d = def(`
name: x
on: { manual: {} }
jobs:
  a: { needs: b, steps: [${step('s')}] }
  b: { needs: a, steps: [${step('s')}] }
`)
  const f = checkGraph(d)
  expect(f).toHaveLength(1)
  expect(f[0]!.rule).toBe('needs-cycle')
  expect(f[0]!.message).toMatch(/a → b|b → a/)
})

test('a valid diamond DAG is clean', () => {
  const d = def(`
name: x
on: { manual: {} }
jobs:
  a: { steps: [${step('s')}] }
  b: { needs: a, steps: [${step('s')}] }
  c: { needs: a, steps: [${step('s')}] }
  d: { needs: [b, c], steps: [${step('s')}] }
`)
  expect(checkGraph(d)).toEqual([])
})
