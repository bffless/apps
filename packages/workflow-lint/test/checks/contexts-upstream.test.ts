import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { collectSites } from '../../src/model/slots.js'
import { checkContexts } from '../../src/checks/contexts.js'
import { checkUpstream } from '../../src/checks/upstream.js'

const run = (yaml: string) => {
  const def = toDefinition(loadYaml(yaml).data)
  const sites = collectSites(def)
  return [...checkContexts(def, sites), ...checkUpstream(def, sites)]
}
const rules = (yaml: string) => run(yaml).map((f) => f.rule).sort()

const BASE = `
name: x
on: { manual: { inputs: { a: { type: string } } } }
`

test('clean fixture: self-summary, later error, poll response, needs listed', () => {
  const f = run(`${BASE}
jobs:
  fan:
    strategy: { matrix: { who: "\${{ inputs.a }}" } }
    steps:
      - id: say
        uses: pipeline
        with: { path: echo, body: { t: "\${{ matrix.who }}" } }
        poll: { path: job, until: "\${{ response.status == 'done' }}" }
        outputs: { line: { type: string, value: "\${{ response.text }}" } }
        summary: "Said \${{ steps.say.outputs.line }}"
      - id: after
        uses: pipeline
        if: \${{ steps.say.outcome == 'failure' && success() }}
        with: { path: echo, body: { t: "\${{ error.message }}" } }
    outputs: { lines: "\${{ steps.say.outputs.line }}" }
  next:
    needs: fan
    steps:
      - id: use
        uses: pipeline
        with: { path: echo, body: { t: "\${{ needs.fan.outputs.lines }}" } }
outputs:
  all: \${{ jobs.fan.outputs.lines }}
`)
  expect(f).toEqual([])
})

test('response in a form summary and matrix outside a matrix job', () => {
  expect(
    rules(`${BASE}
jobs:
  a:
    steps:
      - id: ask
        uses: form
        with: { fields: { ok: { type: boolean } } }
        summary: "got \${{ response.x }} for \${{ matrix.item }}"
`),
  ).toEqual(['context-position', 'context-position'])
})

test('jobs context inside a step; steps in top outputs', () => {
  expect(
    rules(`${BASE}
jobs:
  a:
    steps:
      - id: s
        uses: pipeline
        with: { path: e, body: { t: "\${{ jobs.a.outputs.x }}" } }
outputs:
  y: \${{ steps.s.outputs.line }}
`),
  ).toEqual(['context-position', 'context-position'])
})

test('unknown context and unknown function and status fn outside if', () => {
  expect(
    rules(`${BASE}
jobs:
  a:
    steps:
      - id: s
        uses: pipeline
        with: { path: e, body: { t: "\${{ respnse.x }}" } }
        summary: "ok \${{ succes() }} \${{ always() }}"
`),
  ).toEqual(['status-fn-position', 'unknown-context', 'unknown-function'])
})

test('forward and self references', () => {
  expect(
    rules(`${BASE}
jobs:
  a:
    steps:
      - id: one
        uses: pipeline
        with: { path: e, body: { t: "\${{ steps.two.outputs.x }}", u: "\${{ steps.one.outputs.x }}" } }
        outputs: { x: { type: string, value: "\${{ response.x }}" } }
      - id: two
        uses: pipeline
        with: { path: e }
        outputs: { x: { type: string, value: "\${{ response.x }}" } }
`),
  ).toEqual(['upstream-reference', 'upstream-reference'])
})

test('needs not listed vs nonexistent job', () => {
  const f = run(`${BASE}
jobs:
  a:
    steps: [{ id: s, uses: pipeline, with: { path: e }, outputs: { x: { type: string, value: "\${{ response.x }}" } } }]
    outputs: { x: "\${{ steps.s.outputs.x }}" }
  b:
    steps:
      - id: s
        uses: pipeline
        with: { path: e, body: { t: "\${{ needs.a.outputs.x }}", u: "\${{ needs.ghost.outputs.x }}" } }
`)
  expect(f.map((x) => x.rule)).toEqual(['upstream-reference', 'upstream-reference'])
  expect(f.some((x) => x.message.includes('does not list'))).toBe(true)
  expect(f.some((x) => x.message.includes('no job'))).toBe(true)
})

test('unknown-output warnings for steps, needs and jobs references', () => {
  expect(
    rules(`${BASE}
jobs:
  a:
    steps: [{ id: s, uses: pipeline, with: { path: e }, outputs: { x: { type: string, value: "\${{ response.x }}" } } }]
    outputs: { x: "\${{ steps.s.outputs.typo }}" }
  b:
    needs: a
    steps: [{ id: t, uses: pipeline, with: { path: e, body: { v: "\${{ needs.a.outputs.nope }}" } } }]
outputs:
  y: \${{ jobs.a.outputs.missing }}
`),
  ).toEqual(['unknown-output', 'unknown-output', 'unknown-output'])
})

test('omitted pipeline outputs expose response; outcome/result stay unchecked', () => {
  expect(
    rules(`${BASE}
jobs:
  a:
    steps:
      - id: boom
        uses: pipeline
        continue-on-error: true
        with: { path: fail }
      - id: after
        uses: pipeline
        if: \${{ steps.boom.outcome == 'failure' }}
        with: { path: e, body: { t: "\${{ steps.boom.outputs.response }}", e: "\${{ steps.boom.error.code }}" } }
`),
  ).toEqual([])
})
