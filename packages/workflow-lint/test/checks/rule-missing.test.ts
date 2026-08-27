import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'
import { lintSource } from '../../src/lint.js'
import { scanRuleSet } from '../../src/rules/scan.js'
import type { RuleSetContext } from '../../src/rules/match.js'

const helloDir = fileURLToPath(new URL('../fixtures/rules/hello', import.meta.url))

const WORKFLOW = `
spec: 1
name: Rule coverage
on:
  manual: {}
jobs:
  work:
    steps:
      - id: say
        uses: pipeline
        with: { path: echo, body: { text: hi } }
      - id: slow
        uses: pipeline
        with: { path: echo }
        poll:
          path: job
          until: \${{ response.status == 'done' }}
      - id: harness
        uses: pipeline
        with: { path: /api/workflow/runs, method: POST }
`

const lint = (source: string, rules?: RuleSetContext) =>
  lintSource(source, { file: 'w.yaml', rules }).findings.filter((f) => f.rule === 'rule-missing')

test('every relative path backed by a rule lints clean', () => {
  expect(lint(WORKFLOW, scanRuleSet(helloDir))).toEqual([])
})

test('a renamed pipeline path is an error naming the expected rule file', () => {
  const findings = lint(WORKFLOW.replace('path: echo, body', 'path: echoo, body'), scanRuleSet(helloDir))
  expect(findings).toHaveLength(1)
  expect(findings[0].severity).toBe('error')
  expect(findings[0].message).toContain('POST /api/hello/echoo')
  expect(findings[0].message).toContain('rules/api/hello/echoo/post/rule.yaml')
  expect(findings[0].path).toBe('/jobs/work/steps/0/with/path')
  expect(findings[0].pos?.line).toBeGreaterThan(0)
})

test('a wrong method is an error even when the path exists', () => {
  const findings = lint(WORKFLOW.replace('path: echo, body', 'path: echo, method: GET, body'), scanRuleSet(helloDir))
  expect(findings.map((f) => f.message)).toEqual([
    expect.stringContaining('GET /api/hello/echo'),
  ])
})

test('a missing poll rule is reported at the poll path', () => {
  const findings = lint(WORKFLOW.replace('path: job', 'path: jobs'), scanRuleSet(helloDir))
  expect(findings).toHaveLength(1)
  expect(findings[0].path).toBe('/jobs/work/steps/1/poll/path')
  expect(findings[0].message).toContain('GET /api/hello/jobs')
})

test('absolute paths are never checked — they belong to another set', () => {
  const findings = lint(
    WORKFLOW.replace('path: /api/workflow/runs', 'path: /api/other/thing'),
    scanRuleSet(helloDir),
  )
  expect(findings).toEqual([])
})

test('no rule set: one notice for the file, never an error', () => {
  const findings = lint(WORKFLOW, { found: false, reason: 'no .bffless/proxy-rules directory above w.yaml' })
  expect(findings).toHaveLength(1)
  expect(findings[0].severity).toBe('notice')
  expect(findings[0].path).toBe('')
  expect(findings[0].message).toMatch(/skipping/)
})

test('the in-memory harness lint (no rules given) stays silent', () => {
  expect(lint(WORKFLOW)).toEqual([])
})

test('a workflow with no relative pipeline path gets no notice', () => {
  const harnessOnly = `
spec: 1
name: Harness only
on:
  manual: {}
jobs:
  work:
    steps:
      - id: run
        uses: pipeline
        with: { path: /api/workflow/runs }
`
  expect(lint(harnessOnly, { found: false, reason: 'nope' })).toEqual([])
})
