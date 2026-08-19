import { test, expect } from 'vitest'
import { loadYaml } from '../src/yaml/load.js'

test('parses valid YAML and locates a nested pointer', () => {
  const r = loadYaml('name: hi\njobs:\n  a:\n    steps:\n      - id: one\n')
  expect(r.findings).toEqual([])
  expect((r.data as any).jobs.a.steps[0].id).toBe('one')
  expect(r.locate('/jobs/a/steps/0/id')).toEqual({ line: 5, col: 13 })
})

test('locates the whole document', () => {
  const r = loadYaml('name: hi\n')
  expect(r.locate('')).toEqual({ line: 1, col: 1 })
})

test('reports a parse error with position', () => {
  const r = loadYaml('a: [1, 2\n')
  expect(r.findings[0]!.rule).toBe('yaml-parse')
  expect(r.findings[0]!.severity).toBe('error')
  expect(r.findings[0]!.pos?.line).toBeGreaterThanOrEqual(1)
})

test('unquoted ${{ }} inside a flow mapping gets the quoting hint', () => {
  const r = loadYaml('body: { id: ${{ response.jobId }} }\n')
  expect(r.findings.length).toBeGreaterThan(0)
  expect(r.findings.some((f) => f.hint?.match(/quote/i))).toBe(true)
})

test('duplicate keys are an error', () => {
  const r = loadYaml('a: 1\na: 2\n')
  expect(r.findings[0]!.rule).toBe('yaml-parse')
})
