import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'
import { buildIndex } from '../src/index/index.js'

const example = (n: string) =>
  fileURLToPath(new URL(`../../../apps/workflow/docs/spec/examples/${n}`, import.meta.url))

const HELLO_YAML = readFileSync(example('hello.workflow.yaml'), 'utf8')

/** The rule check is a notice, never an error, when the caller has no set to offer. */
const NO_RULES = { found: false, reason: 'test' } as const

const BASE = {
  impl: 'hello',
  name: 'Hello',
  version: '1.0.0',
  commit: 'abc1234',
  islands: ['islands/pick-line.html'],
  scripts: [],
  rules: NO_RULES,
}

test('lints, counts and lists', () => {
  const r = buildIndex({ ...BASE, workflows: [{ file: 'hello.workflow.yaml', yaml: HELLO_YAML }] })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.index.workflows[0]).toMatchObject({
    file: 'hello.workflow.yaml',
    name: 'Hello workflow',
    description: 'Smoke-tests every non-interactive feature of the harness.',
    inputs: 4,
    jobs: 4,
    headlessSafe: true,
  })
})

test('the index carries the bundle metadata the harness reads', () => {
  const r = buildIndex({
    ...BASE,
    description: 'A bundle.',
    workflows: [{ file: 'hello.workflow.yaml', yaml: HELLO_YAML }],
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.index).toMatchObject({
    spec: 1,
    impl: 'hello',
    name: 'Hello',
    description: 'A bundle.',
    version: '1.0.0',
    commit: 'abc1234',
    islands: ['islands/pick-line.html'],
    scripts: [],
  })
  // generatedAt is the writer's, not the builder's — buildIndex is pure.
  expect(r.index).not.toHaveProperty('generatedAt')
})

test('a missing description is the empty string, not undefined', () => {
  const r = buildIndex({ ...BASE, workflows: [{ file: 'hello.workflow.yaml', yaml: HELLO_YAML }] })
  expect(r.ok && r.index.description).toBe('')
})

test('a lint error fails the index', () => {
  const r = buildIndex({ ...BASE, workflows: [{ file: 'x.yaml', yaml: 'spec: 1\n' }] })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.findings.every((f) => f.file === 'x.yaml')).toBe(true)
  expect(r.findings.some((f) => f.severity === 'error')).toBe(true)
})

test('a lint warning fails the index too — a failing lint is never published (06)', () => {
  const warned = readFileSync(
    fileURLToPath(new URL('./fixtures/broken/file-ref-body.workflow.yaml', import.meta.url)),
    'utf8',
  )
  const r = buildIndex({ ...BASE, workflows: [{ file: 'w.yaml', yaml: warned }] })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.findings.some((f) => f.severity === 'warning')).toBe(true)
})

test('a notice alone still publishes', () => {
  // hello's only finding is the `outputs-omitted` notice.
  const r = buildIndex({ ...BASE, workflows: [{ file: 'hello.workflow.yaml', yaml: HELLO_YAML }] })
  expect(r.ok).toBe(true)
})

test('every failing workflow is reported, not just the first', () => {
  const r = buildIndex({
    ...BASE,
    workflows: [
      { file: 'a.yaml', yaml: 'spec: 1\n' },
      { file: 'b.yaml', yaml: 'spec: 1\n' },
    ],
  })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(new Set(r.findings.map((f) => f.file))).toEqual(new Set(['a.yaml', 'b.yaml']))
})

test('the rule set is threaded into the lint, so a missing rule fails the index', () => {
  const rules = {
    found: true as const,
    alias: 'plain',
    dir: '/nowhere',
    prefix: '/api/plain',
    layout: '',
    rules: [{ pattern: '/api/plain/echo', methods: ['POST'], source: 'rules/echo/post/rule.yaml' }],
  }
  const yaml = 'spec: 1\nname: P\non:\n  manual: {}\njobs:\n  e:\n    steps:\n      - id: e\n        uses: pipeline\n        with: { path: echoo }\n'
  const r = buildIndex({ ...BASE, rules, workflows: [{ file: 'p.yaml', yaml }] })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.findings.some((f) => f.rule === 'rule-missing' && f.severity === 'error')).toBe(true)
})
