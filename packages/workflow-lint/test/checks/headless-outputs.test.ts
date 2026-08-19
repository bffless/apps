import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { collectSites } from '../../src/model/slots.js'
import { checkHeadless } from '../../src/checks/headless.js'
import { checkOutputs } from '../../src/checks/outputs.js'

const run = (yaml: string) => {
  const def = toDefinition(loadYaml(yaml).data)
  const sites = collectSites(def)
  return { headless: checkHeadless(def, sites), outputs: checkOutputs(def) }
}

const BASE = `
name: x
on: { manual: { inputs: { a: { type: string } } } }
`

test('bare headless: skip with a referenced output is an error', () => {
  const { headless } = run(`${BASE}
jobs:
  j:
    steps:
      - id: review
        uses: form
        with: { fields: { approved: { type: boolean } } }
        headless: skip
    outputs:
      ok: \${{ steps.review.outputs.approved }}
`)
  expect(headless).toHaveLength(1)
  expect(headless[0]).toMatchObject({ rule: 'headless-skip-outputs', severity: 'error' })
})

test('skip with the referenced value provided is clean', () => {
  const { headless } = run(`${BASE}
jobs:
  j:
    steps:
      - id: review
        uses: form
        with: { fields: { approved: { type: boolean } } }
        headless: { mode: skip, outputs: { approved: true } }
    outputs:
      ok: \${{ steps.review.outputs.approved }}
`)
  expect(headless).toEqual([])
})

test('skip with empty outputs map + later-step reference is an error', () => {
  const { headless } = run(`${BASE}
jobs:
  j:
    steps:
      - id: pick
        uses: form
        with: { fields: { choice: { type: string } } }
        headless: { mode: skip, outputs: {} }
      - id: use
        uses: pipeline
        with: { path: e, body: { c: "\${{ steps.pick.outputs.choice }}" } }
`)
  expect(headless.map((f) => f.rule)).toEqual(['headless-skip-outputs'])
})

test('an unreferenced skip output and mode auto are clean', () => {
  const { headless } = run(`${BASE}
jobs:
  j:
    steps:
      - id: pick
        uses: form
        with: { fields: { choice: { type: string } } }
        headless: skip
      - id: trim
        uses: island
        with: { src: islands/x.html }
        outputs: { cuts: { type: json } }
        headless: { mode: auto }
`)
  expect(headless).toEqual([])
})

test('interactive step without headless is a notice', () => {
  const { headless } = run(`${BASE}
jobs:
  j:
    steps:
      - id: ask
        uses: form
        with: { fields: { ok: { type: boolean } } }
`)
  expect(headless).toHaveLength(1)
  expect(headless[0]).toMatchObject({ rule: 'interactive-headless', severity: 'notice' })
})

test('pipeline without outputs is a notice; scripts/islands are not', () => {
  const { outputs } = run(`${BASE}
jobs:
  j:
    steps:
      - id: boom
        uses: pipeline
        with: { path: fail }
`)
  expect(outputs).toHaveLength(1)
  expect(outputs[0]).toMatchObject({ rule: 'outputs-omitted', severity: 'notice' })
})

test('computed job output is a notice; direct refs and object form are clean', () => {
  const { outputs } = run(`${BASE}
jobs:
  j:
    steps:
      - id: s
        uses: pipeline
        with: { path: e }
        outputs: { x: { type: json, value: "\${{ response.x }}" } }
    outputs:
      computed: "\${{ length(steps.s.outputs.x) }}"
      direct: \${{ steps.s.outputs.x }}
      input: \${{ inputs.a }}
      typed: { type: number, value: "\${{ length(steps.s.outputs.x) }}" }
`)
  expect(outputs.map((f) => f.rule)).toEqual(['untyped-job-output'])
  expect(outputs[0]!.path).toBe('/jobs/j/outputs/computed')
})
