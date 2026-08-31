import { readFileSync } from 'node:fs'
import { test, expect } from 'vitest'
import { lintSource } from '../src/index.js'

const example = (n: string) =>
  readFileSync(new URL(`../../../apps/workflow/docs/spec/examples/${n}`, import.meta.url), 'utf8')

test('hello.workflow.yaml lints clean (one known notice)', () => {
  const r = lintSource(example('hello.workflow.yaml'), { file: 'hello.workflow.yaml' })
  expect(r.findings.filter((f) => f.severity !== 'notice')).toEqual([])
  // flaky/boom deliberately omits outputs; 03 says the linter flags it — as a notice.
  expect(r.findings.map((f) => f.rule)).toEqual(['outputs-omitted'])
  expect(r.counts).toEqual({ errors: 0, warnings: 0, notices: 1 })
})

// studio.workflow.yaml moved with its implementation to
// bffless/workflow-implementations (M4); its "lints fully clean against the
// real rule set" check runs in that repo's own CI, and the built-bin smokes in
// cli.test.ts cover the publisher-flag invocation against a vendored fixture.
