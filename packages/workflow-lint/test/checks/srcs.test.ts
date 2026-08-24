import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { checkSrcs } from '../../src/checks/srcs.js'

const run = (yaml: string) => checkSrcs(toDefinition(loadYaml(yaml).data))

test('island step with a bad src extension errors', () => {
  const findings = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: s
        uses: island
        with: { src: islands/x.htm }
        outputs:
          done: { type: boolean }
`)
  expect(findings.map((f) => f.rule)).toEqual(['island-src-ext'])
  expect(findings[0]!.severity).toBe('error')
})

test('script step with a bad src extension errors', () => {
  const findings = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: s
        uses: script
        with: { src: scripts/x.ts }
        outputs:
          done: { type: boolean }
`)
  expect(findings.map((f) => f.rule)).toEqual(['script-src-ext'])
  expect(findings[0]!.severity).toBe('error')
})

test('island .html and script .js/.mjs src are clean', () => {
  const findings = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: a
        uses: island
        with: { src: islands/x.html }
        outputs:
          done: { type: boolean }
      - id: b
        uses: script
        with: { src: scripts/x.js }
        outputs:
          done: { type: boolean }
      - id: c
        uses: script
        with: { src: scripts/x.mjs }
        outputs:
          done: { type: boolean }
`)
  expect(findings).toEqual([])
})

test('render: island output with a bad src extension errors island-src-ext', () => {
  const findings = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: s
        uses: pipeline
        with: { path: e }
        outputs:
          v: { type: json, render: island, src: v.js }
`)
  expect(findings.map((f) => f.rule)).toEqual(['island-src-ext'])
})

test('render: island output with .html src is clean', () => {
  const findings = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: s
        uses: pipeline
        with: { path: e }
        outputs:
          v: { type: json, render: island, src: islands/v.html }
`)
  expect(findings).toEqual([])
})

test('render: island output with no src is not flagged by checkSrcs (island-render-src covers it)', () => {
  const findings = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: s
        uses: pipeline
        with: { path: e }
        outputs:
          v: { type: json, render: island }
`)
  expect(findings).toEqual([])
})

test('island step with `with.arguments` errors island-reserved-with', () => {
  const findings = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: s
        uses: island
        with: { src: islands/x.html, arguments: 1 }
        outputs:
          done: { type: boolean }
`)
  expect(findings.map((f) => f.rule)).toEqual(['island-reserved-with'])
  expect(findings[0]!.severity).toBe('error')
  expect(findings[0]!.message).toMatch(/arguments/)
})

test('island step with title/display but no `arguments` key is clean', () => {
  const findings = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: s
        uses: island
        with: { src: islands/x.html, title: Report, display: fullscreen }
        outputs:
          done: { type: boolean }
`)
  expect(findings).toEqual([])
})
