import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { collectSites } from '../../src/model/slots.js'
import { TypeEnv } from '../../src/model/types.js'
import { parseExpression } from '../../src/expressions/parser.js'
import { checkRender } from '../../src/checks/render.js'
import { checkPaths } from '../../src/checks/paths.js'
import { checkBody } from '../../src/checks/body.js'

const FIXTURE = `
name: types fixture
on:
  manual:
    inputs:
      recordings: { type: file, list: true, required: true }
      note: { type: string }
jobs:
  per-video:
    strategy:
      matrix: { video: "\${{ inputs.recordings }}" }
    steps:
      - id: transcribe
        uses: pipeline
        with: { path: transcribe, body: { source: "\${{ matrix.video.path }}" } }
        outputs:
          words: { type: json, value: "\${{ response.words }}" }
      - id: sheet
        uses: script
        with: { src: scripts/s.js, video: "\${{ matrix.video }}" }
        outputs:
          sheets: { type: file, list: true }
    outputs:
      words: \${{ steps.transcribe.outputs.words }}
      sheets: \${{ steps.sheet.outputs.sheets }}
  use:
    needs: per-video
    steps:
      - id: ok
        uses: pipeline
        with: { path: scenes, body: { sheets: "\${{ pluck(needs.per-video.outputs.sheets, 'path') }}" } }
`

const def = toDefinition(loadYaml(FIXTURE).data)
const env = new TypeEnv(def)
const infer = (src: string, jobId?: string) =>
  env.infer(parseExpression(src), jobId ? def.jobs[jobId] : undefined)

test('type env resolves inputs, matrix vars, step and job outputs', () => {
  expect(infer('inputs.recordings')).toEqual({ base: 'file', list: 1 })
  expect(infer('matrix.video', 'per-video')).toEqual({ base: 'file', list: 0 })
  expect(infer('matrix.video.path', 'per-video')).toEqual({ base: 'string', list: 0 })
  expect(infer('steps.transcribe.outputs.words', 'per-video')).toEqual({ base: 'json', list: 0 })
  // matrix job lifts outputs one list level
  expect(infer('needs.per-video.outputs.words', 'use')).toEqual({ base: 'json', list: 1 })
  expect(infer('needs.per-video.outputs.sheets', 'use')).toEqual({ base: 'file', list: 2 })
  expect(infer("pluck(needs.per-video.outputs.sheets, 'path')", 'use')).toEqual({ base: 'string', list: 2 })
  expect(infer('needs.per-video.outputs.sheets[0][0].path', 'use')).toEqual({ base: 'string', list: 0 })
})

const run = (yaml: string) => {
  const d = toDefinition(loadYaml(yaml).data)
  return {
    render: checkRender(d),
    paths: checkPaths(d),
    body: checkBody(d, collectSites(d)),
  }
}

test('unknown render and render island without src', () => {
  const { render } = run(`
name: x
on: { manual: { inputs: { a: { type: string, render: fancy } } } }
jobs:
  j:
    steps:
      - id: s
        uses: pipeline
        with: { path: e }
        outputs:
          cuts: { type: json, render: island }
`)
  expect(render.map((f) => f.rule).sort()).toEqual(['island-render-src', 'unknown-render'])
})

test('valid renderers and island with src are clean', () => {
  const { render } = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: s
        uses: pipeline
        with: { path: e }
        outputs:
          words: { type: json, render: transcript }
          cuts: { type: json, render: island, src: islands/x.html }
`)
  expect(render).toEqual([])
})

test('cross-impl absolute paths warn; harness and relative paths are clean', () => {
  const { paths } = run(`
name: x
on: { manual: {} }
jobs:
  j:
    steps:
      - id: a
        uses: pipeline
        with: { path: /api/studio/transcribe }
        poll: { path: /api/other/job, until: "\${{ response.done }}" }
      - id: b
        uses: pipeline
        with: { path: /api/workflow/files/list }
      - id: c
        uses: pipeline
        with: { path: transcribe }
`)
  expect(paths).toHaveLength(2)
  expect(paths.every((f) => f.rule === 'cross-impl-path' && f.severity === 'warning')).toBe(true)
})

test('whole file refs in pipeline bodies warn; .path, pluck and script with are clean', () => {
  const { body } = run(FIXTURE)
  expect(body).toEqual([])

  const bad = run(`
name: x
on: { manual: { inputs: { rec: { type: file }, recs: { type: file, list: true } } } }
jobs:
  j:
    steps:
      - id: s
        uses: pipeline
        with: { path: e, body: { one: "\${{ inputs.rec }}", many: "\${{ inputs.recs }}", ok: "\${{ inputs.rec.path }}" } }
`)
  expect(bad.body).toHaveLength(2)
  expect(bad.body[0]!.rule).toBe('file-ref-in-body')
  expect(bad.body.map((f) => f.hint)).toEqual(['pass ref.path', "pass pluck(list, 'path')"])
})
