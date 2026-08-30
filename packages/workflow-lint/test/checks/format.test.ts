import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { checkFormat } from '../../src/checks/format.js'
import { validateDefinition } from '../../src/schema/validate.js'

const BASE = `
name: x
on: { manual: { inputs: { a: { type: string } } } }
`

const run = (yaml: string) => checkFormat(toDefinition(loadYaml(yaml).data))

/** Every viewer format on the type that reads it (02, apps#450) — schema-valid and check-clean. */
const COMPATIBLE = `${BASE}
jobs:
  j:
    steps:
      - id: p
        uses: pipeline
        with: { path: x }
        outputs:
          cuts:   { type: json, value: "\${{ response.cuts }}", format: table, columns: [start, end] }
          times:  { type: json, value: "\${{ response.times }}", format: list }
          spans:  { type: json, value: "\${{ response.spans }}", format: seconds }
          at:     { type: number, value: "\${{ response.at }}", format: seconds }
          src:    { type: string, value: "\${{ response.src }}", format: path }
          note:   { type: string, value: "\${{ response.note }}", format: textarea }
    outputs:
      cuts: { type: json, value: "\${{ steps.p.outputs.cuts }}", format: table }
outputs:
  src: { type: string, value: "\${{ jobs.j.outputs.cuts }}", format: path }
`

test('every format on a type that reads it: schema-valid and no finding', () => {
  expect(validateDefinition(loadYaml(COMPATIBLE).data)).toEqual([])
  expect(run(COMPATIBLE)).toEqual([])
})

test('a format on a type whose viewer does not read it is an error, at every declaration site', () => {
  const f = run(`${BASE.replace('{ type: string }', '{ type: number, format: textarea }')}
jobs:
  j:
    steps:
      - id: p
        uses: pipeline
        with: { path: x }
        outputs:
          cuts:  { type: table, value: "\${{ response.cuts }}", format: table }
          times: { type: number, value: "\${{ response.times }}", format: list }
          src:   { type: json, value: "\${{ response.src }}", format: path }
          ok:    { type: json, value: "\${{ response.ok }}", format: seconds }
      - id: f
        uses: form
        with:
          fields:
            when: { type: string, format: seconds }
    outputs:
      cuts: { type: markdown, value: "\${{ steps.p.outputs.cuts }}", format: list }
`)
  expect(f.map((x) => [x.rule, x.path])).toEqual([
    ['format-type', '/on/manual/inputs/a/format'],
    ['format-type', '/jobs/j/steps/0/outputs/cuts/format'],
    ['format-type', '/jobs/j/steps/0/outputs/times/format'],
    ['format-type', '/jobs/j/steps/0/outputs/src/format'],
    ['format-type', '/jobs/j/steps/1/with/fields/when/format'],
    ['format-type', '/jobs/j/outputs/cuts/format'],
  ])
  expect(f[1]!.message).toBe('`format: table` is only read on a `json` declaration (02); this declaration is `table`')
  expect(f[4]!.message).toBe('`format: seconds` is only read on a `number` / `json` declaration (02); this declaration is `string`')
})

test('a format outside the vocabulary is the schema’s finding, not this check’s', () => {
  const yaml = `${BASE}
jobs:
  j:
    steps:
      - id: p
        uses: pipeline
        with: { path: x }
        outputs:
          x: { type: json, value: "\${{ response.x }}", format: grid }
`
  expect(run(yaml)).toEqual([])
  expect(validateDefinition(loadYaml(yaml).data).map((f) => f.rule)).toEqual(['schema'])
})
