import { test, expect } from 'vitest'
import { loadYaml } from '../../src/yaml/load.js'
import { toDefinition } from '../../src/model/definition.js'
import { collectSites } from '../../src/model/slots.js'
import { checkContexts } from '../../src/checks/contexts.js'
import { checkUpstream } from '../../src/checks/upstream.js'
import { checkImages } from '../../src/checks/images.js'
import { validateDefinition } from '../../src/schema/validate.js'

const BASE = `
name: x
on: { manual: { inputs: { a: { type: string } } } }
`

/** The Studio shape (apps#446): a pipeline step maps its frames, a later step reads the map. */
const STUDIO = `${BASE}
jobs:
  blog:
    steps:
      - id: frames
        uses: pipeline
        with: { path: video/frames, body: { t: "\${{ inputs.a }}" } }
        outputs:
          srcs: { type: json, value: "\${{ response.result.srcs }}" }
      - id: review
        uses: island
        with: { src: islands/blog-editor.html, post: "\${{ inputs.a }}" }
        outputs:
          post: { type: markdown, images: "\${{ steps.frames.outputs.srcs }}" }
      - id: bundle
        uses: script
        with: { src: scripts/blog-bundle.js, markdown: "\${{ steps.review.outputs.post }}" }
        outputs:
          post: { type: markdown, images: "\${{ steps.bundle.outputs.srcs }}" }
          srcs: { type: json }
    outputs:
      post: { type: markdown, value: "\${{ steps.bundle.outputs.post }}", images: "\${{ steps.bundle.outputs.srcs }}" }
`

const load = (yaml: string) => toDefinition(loadYaml(yaml).data)
const run = (yaml: string) => {
  const def = load(yaml)
  const sites = collectSites(def)
  return [...checkContexts(def, sites), ...checkUpstream(def, sites), ...checkImages(def)]
}
const rules = (yaml: string) => run(yaml).map((f) => f.rule).sort()

test('images on markdown outputs: schema-valid, expression collected, self-reference allowed', () => {
  expect(validateDefinition(loadYaml(STUDIO).data)).toEqual([])
  expect(rules(STUDIO)).toEqual([])

  const sites = collectSites(load(STUDIO))
  const images = sites.filter((s) => s.pointer.endsWith('/images'))
  expect(images.map((s) => [s.pointer, s.slot.where])).toEqual([
    ['/jobs/blog/steps/1/outputs/post/images', 'step-output-images'],
    ['/jobs/blog/steps/2/outputs/post/images', 'step-output-images'],
    ['/jobs/blog/outputs/post/images', 'job-output'],
  ])
})

test('a step-level images map may not read `response` — it is evaluated after the step, not from it', () => {
  const f = run(`${BASE}
jobs:
  j:
    steps:
      - id: p
        uses: pipeline
        with: { path: x }
        outputs:
          post: { type: markdown, value: "\${{ response.md }}", images: "\${{ response.srcs }}" }
`)
  expect(f.map((x) => [x.rule, x.path])).toEqual([
    ['context-position', '/jobs/j/steps/0/outputs/post/images'],
  ])
})

test('images on a non-markdown declaration is an error', () => {
  const f = run(`${BASE}
jobs:
  j:
    steps:
      - id: p
        uses: pipeline
        with: { path: x }
        outputs:
          post: { type: string, value: "\${{ response.md }}", images: "\${{ inputs.a }}" }
    outputs:
      post: { type: json, value: "\${{ steps.p.outputs.post }}", images: { a: b } }
`)
  expect(f.map((x) => [x.rule, x.path])).toEqual([
    ['markdown-images', '/jobs/j/steps/0/outputs/post/images'],
    ['markdown-images', '/jobs/j/outputs/post/images'],
  ])
  expect(f[0]!.message).toContain('`string`')
})

test('images must be an expression or a map', () => {
  const f = run(`${BASE}
jobs:
  j:
    steps:
      - id: p
        uses: pipeline
        with: { path: x }
        outputs:
          post: { type: markdown, value: "\${{ response.md }}", images: [a, b] }
          ok: { type: markdown, value: "\${{ response.md }}", images: { "frame:1": "workflows/x/f.jpg" } }
`)
  expect(f.map((x) => [x.rule, x.path])).toEqual([
    ['markdown-images', '/jobs/j/steps/0/outputs/post/images'],
  ])
})
