import { readFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { lintSource } from '../src/index.js'

const example = (n: string) =>
  readFileSync(new URL(`../../../apps/workflow/docs/spec/examples/${n}`, import.meta.url), 'utf8')

// studio.workflow.yaml ships with its implementation (M3 Task 19), not the
// spec's examples — it's the only workflow checked against a real rule set.
const appWorkflow = (app: string, n: string) =>
  readFileSync(new URL(`../../../apps/${app}/.bffless/workflows/${n}`, import.meta.url), 'utf8')

test('hello.workflow.yaml lints clean (one known notice)', () => {
  const r = lintSource(example('hello.workflow.yaml'), { file: 'hello.workflow.yaml' })
  expect(r.findings.filter((f) => f.severity !== 'notice')).toEqual([])
  // flaky/boom deliberately omits outputs; 03 says the linter flags it — as a notice.
  expect(r.findings.map((f) => f.rule)).toEqual(['outputs-omitted'])
  expect(r.counts).toEqual({ errors: 0, warnings: 0, notices: 1 })
})

test('studio.workflow.yaml lints fully clean', () => {
  // No rule set given: rule-missing only fires when one is (checkRules), so
  // this still asserts the workflow itself — schema, expressions, static
  // checks — is fully clean, independent of workflow-studio's rules (Tasks 20-21).
  const r = lintSource(appWorkflow('workflow-studio', 'studio.workflow.yaml'), { file: 'studio.workflow.yaml' })
  expect(r.findings).toEqual([])
  expect(r.counts).toEqual({ errors: 0, warnings: 0, notices: 0 })
})
