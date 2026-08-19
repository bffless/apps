import { readFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { lintSource } from '../src/index.js'

const lint = (fixture: string) =>
  lintSource(
    readFileSync(new URL(`./fixtures/broken/${fixture}.workflow.yaml`, import.meta.url), 'utf8'),
    { file: fixture },
  )

// Exact multiset of rules per fixture — extra findings are false positives.
const EXPECTED: Record<string, string[]> = {
  'schema-bad-shape': ['schema', 'schema', 'schema'],
  'expr-syntax': ['expr-parse', 'expr-parse'],
  'forward-reference': ['upstream-reference', 'upstream-reference'],
  'needs-violations': ['needs-cycle', 'needs-unknown', 'upstream-reference'],
  'context-misuse': [
    'context-position',
    'context-position',
    'context-position',
    'status-fn-position',
    'unknown-function',
  ],
  'unknown-render': ['island-render-src', 'unknown-render'],
  'no-headless': ['interactive-headless'],
  'file-ref-body': ['file-ref-in-body', 'file-ref-in-body'],
  'cross-impl-path': ['cross-impl-path', 'cross-impl-path'],
  'skip-missing-output': ['headless-skip-outputs', 'headless-skip-outputs'],
  'dup-and-untyped': ['duplicate-step-id', 'outputs-omitted', 'untyped-job-output'],
}

for (const [fixture, rules] of Object.entries(EXPECTED)) {
  test(`corpus: ${fixture}`, () => {
    expect(lint(fixture).findings.map((f) => f.rule).sort()).toEqual([...rules].sort())
  })
}

test('corpus: flow-expr-unquoted reports yaml-parse with the quoting hint', () => {
  const r = lint('flow-expr-unquoted')
  expect(r.findings.length).toBeGreaterThan(0)
  expect(r.findings.every((f) => f.rule === 'yaml-parse')).toBe(true)
  expect(r.findings.some((f) => f.hint?.match(/quoted/i))).toBe(true)
})

test('corpus: every error/warning fixture exits dirty, notices stay clean', () => {
  expect(lint('no-headless').counts).toEqual({ errors: 0, warnings: 0, notices: 1 })
  expect(lint('file-ref-body').counts.warnings).toBe(2)
  expect(lint('skip-missing-output').counts.errors).toBe(2)
})
