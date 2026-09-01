import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'
import { lintSource } from '../../src/lint.js'
import { scanRuleSet } from '../../src/rules/scan.js'
import type { RuleSetContext } from '../../src/rules/match.js'

const bareDir = fileURLToPath(new URL('../fixtures/rules/bare', import.meta.url))
const helloDir = fileURLToPath(new URL('../fixtures/rules/hello', import.meta.url))

// One relative path, served by the bare set's `rules/echo/post/rule.yaml`.
const WORKFLOW = `
spec: 1
name: Prefix check
on:
  manual: {}
jobs:
  work:
    steps:
      - id: say
        uses: pipeline
        with: { path: echo, body: { text: hi } }
`

const lint = (source: string, rules?: RuleSetContext) => lintSource(source, { file: 'w.yaml', rules }).findings

const mismatches = (source: string, rules?: RuleSetContext) =>
  lint(source, rules).filter((f) => f.rule === 'path-prefix-mismatch')

test('a --path-prefix the publisher would never apply is an error naming both values', () => {
  // The rule-missing check alone cannot see this: the prefix is prepended to
  // both sides of the comparison, so `/nonsense` resolves as cleanly as
  // `/api/hello` (#560). The mismatch finding is the only signal.
  const rules = scanRuleSet(bareDir, { alias: 'hello', pathPrefix: '/nonsense' })
  const findings = mismatches(WORKFLOW, rules)
  expect(findings).toHaveLength(1)
  expect(findings[0].severity).toBe('error')
  expect(findings[0].message).toContain('/nonsense')
  expect(findings[0].message).toContain('/api/hello')
  expect(findings[0].path).toBe('')
  // …and the cancellation is real: rule-missing still reports nothing.
  expect(lint(WORKFLOW, rules).filter((f) => f.rule === 'rule-missing')).toEqual([])
})

test("the publisher's own value, /api/<alias>, lints clean and resolution is unchanged", () => {
  const rules = scanRuleSet(bareDir, { alias: 'hello', pathPrefix: '/api/hello' })
  expect(mismatches(WORKFLOW, rules)).toEqual([])
  expect(lint(WORKFLOW, rules).filter((f) => f.rule === 'rule-missing')).toEqual([])
})

test('a guessed bare /api is the demonstrated failure — caught, naming /api/<alias>', () => {
  const findings = mismatches(WORKFLOW, scanRuleSet(bareDir, { alias: 'hello', pathPrefix: '/api' }))
  expect(findings).toHaveLength(1)
  expect(findings[0].message).toContain('/api/hello')
})

test('without --path-prefix there is nothing to validate — prefixes read off the set stay silent', () => {
  expect(mismatches(WORKFLOW, scanRuleSet(helloDir))).toEqual([])
})

test('the mismatch is about the flag, not the file: it fires even with no relative path', () => {
  const absoluteOnly = `
spec: 1
name: Absolute only
on:
  manual: {}
jobs:
  work:
    steps:
      - id: run
        uses: pipeline
        with: { path: /api/workflow/runs }
`
  const rules = scanRuleSet(bareDir, { alias: 'hello', pathPrefix: '/nonsense' })
  expect(mismatches(absoluteOnly, rules)).toHaveLength(1)
})

test('an unresolved rule set has no alias to compare against — no mismatch finding', () => {
  expect(mismatches(WORKFLOW, { found: false, reason: 'nope' })).toEqual([])
})

test('the harness lint (no rules given) stays silent', () => {
  expect(mismatches(WORKFLOW)).toEqual([])
})
