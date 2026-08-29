import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { collectSites } from '../../src/model/slots.js'
import { checkContexts } from '../../src/checks/contexts.js'
import { checkHeadless } from '../../src/checks/headless.js'
import { validateDefinition } from '../../src/schema/validate.js'

const run = (yaml: string) => {
  const doc = loadYaml(yaml)
  const def = toDefinition(doc.data)
  const sites = collectSites(def)
  return {
    schema: validateDefinition(doc.data),
    headless: checkHeadless(def, sites),
    contexts: checkContexts(def, sites),
    sites,
  }
}

const BASE = `
name: x
on: { manual: { inputs: { accept_cuts: { type: boolean, default: true } } } }
`

test('auto-accept on a headless: auto island is clean, and its expression is a collected site', () => {
  const { schema, headless, contexts, sites } = run(`${BASE}
jobs:
  scenes:
    steps:
      - id: trim
        uses: island
        with: { src: islands/trim.html, title: Trim }
        outputs: { keep: { type: json } }
        headless: auto
        auto-accept: \${{ inputs.accept_cuts }}
`)
  expect(schema).toEqual([])
  expect(headless).toEqual([])
  expect(contexts).toEqual([])
  expect(sites.find((s) => s.slot.where === 'auto-accept')).toMatchObject({
    pointer: '/jobs/scenes/steps/0/auto-accept',
    raw: ' inputs.accept_cuts ',
    isWholeValue: true,
    slot: { stepId: 'trim', stepUses: 'island' },
  })
})

test('auto-accept is a step slot: a context that is not readable there is reported at the key', () => {
  const { contexts } = run(`${BASE}
jobs:
  scenes:
    steps:
      - id: trim
        uses: island
        with: { src: islands/trim.html, title: Trim }
        outputs: { keep: { type: json } }
        headless: auto
        auto-accept: \${{ response.ok }}
`)
  expect(contexts).toHaveLength(1)
  expect(contexts[0]).toMatchObject({ severity: 'error', path: '/jobs/scenes/steps/0/auto-accept' })
})

test('auto-accept on a step with no headless: is an error (plus the usual not-headless-safe notice)', () => {
  const { headless } = run(`${BASE}
jobs:
  j:
    steps:
      - id: review
        uses: form
        with: { fields: { approved: { type: boolean, default: true } } }
        auto-accept: true
`)
  expect(headless.map((f) => [f.rule, f.severity])).toEqual([
    ['auto-accept-headless', 'error'],
    ['interactive-headless', 'notice'],
  ])
  expect(headless[0]!.path).toBe('/jobs/j/steps/0/auto-accept')
})

test('a bare boolean auto-accept on a headless: skip form is clean', () => {
  const { schema, headless } = run(`${BASE}
jobs:
  j:
    steps:
      - id: review
        uses: form
        with: { fields: { approved: { type: boolean } } }
        headless: { mode: skip, outputs: { approved: true } }
        auto-accept: true
`)
  expect(schema).toEqual([])
  expect(headless).toEqual([])
})

test('auto-accept is not a key a pipeline step may carry', () => {
  const { schema } = run(`${BASE}
jobs:
  j:
    steps:
      - id: go
        uses: pipeline
        with: { path: go }
        auto-accept: true
`)
  expect(schema.length).toBeGreaterThan(0)
})
