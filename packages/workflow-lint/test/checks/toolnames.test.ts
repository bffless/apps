import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { checkToolNames } from '../../src/checks/toolnames.js'

const run = (yaml: string) => checkToolNames(toDefinition(loadYaml(yaml).data))

const withIsland = (extraSteps: string) => `
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: view
        uses: island
        with: { src: islands/x.html }
        outputs:
          done: { type: boolean }
${extraSteps}
`

test('pipeline path with a `.` alongside an island step gets a tool-name-dot notice', () => {
  const findings = run(
    withIsland(`
      - id: feed
        uses: pipeline
        with: { path: feed.xml }
`),
  )
  expect(findings.map((f) => f.rule)).toEqual(['tool-name-dot'])
  expect(findings[0]!.severity).toBe('notice')
})

test('the same dotted pipeline path with no island step in the workflow: no notice', () => {
  const findings = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: feed
        uses: pipeline
        with: { path: feed.xml }
`)
  expect(findings).toEqual([])
})

test('a pipeline path with no `.` alongside an island step: no notice', () => {
  const findings = run(
    withIsland(`
      - id: ok
        uses: pipeline
        with: { path: feed }
`),
  )
  expect(findings).toEqual([])
})
