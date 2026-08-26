/**
 * One completed `rendered` run, as the rows a real run would have left behind
 * (05) — the Phase-3 counterpart of `finishedRun.ts`/`scriptRun.ts`, built to
 * prove one thing neither of those needs: that all five named renderers
 * (`transcript`, `chart`, `code`, `images`, `island`) reach the screen from a
 * *replayed* run, through `RunOutputs` and through `StepPane`'s Output tab,
 * not just through `ValueView`'s own direct dispatch tests.
 *
 * Its definition is written inline here rather than loaded from a
 * `docs/spec/examples/*.workflow.yaml` file — `hello.workflow.yaml` and
 * `interactive.workflow.yaml` stay byte-identical for the rest of this phase
 * (shared-context.md), and this workflow exists purely as a renderer fixture,
 * not as a spec example. One job (`show`), one pipeline step (`render`) whose
 * five declared outputs each carry one of the named renderers; the run-level
 * outputs re-export all five with a bare `${{ jobs.show.outputs.* }}`
 * expression, exactly the way `hello.workflow.yaml`'s job outputs do — so
 * `resolveOutputDecl` has to walk run → job → step to find each `render`.
 */
import { fileUrl } from '../../lib/coerce'
import { loadWorkflow } from '../../lib/runner/definition'
import type { RunRow, StepRow } from '../../lib/runner/rows'
import type { FileRef } from '../../lib/runner/types'

const RENDERED_YAML = `spec: 1
name: Rendered outputs
description: Exercises every named renderer from one pipeline step's outputs (M2 Task 17).

on:
  manual: {}

jobs:
  show:
    steps:
      - id: render
        uses: pipeline
        with: { path: render, body: {} }
        outputs:
          words:   { type: json, value: "\${{ response.words }}", render: transcript }
          counts:  { type: table, value: "\${{ response.counts }}", render: chart, mapping: { x: line, y: chars, kind: bar }, columns: [{key: line}, {key: chars, type: number}] }
          snippet: { type: string, value: "\${{ response.snippet }}", render: code, mapping: { language: javascript } }
          pics:    { type: file, list: true, value: "\${{ response.pics }}", render: images }
          view:    { type: json, value: "\${{ response.view }}", render: island, src: islands/line-viewer.html }
    outputs:
      words: \${{ steps.render.outputs.words }}
      counts: \${{ steps.render.outputs.counts }}
      snippet: \${{ steps.render.outputs.snippet }}
      pics: \${{ steps.render.outputs.pics }}
      view: \${{ steps.render.outputs.view }}

outputs:
  words: \${{ jobs.show.outputs.words }}
  counts: \${{ jobs.show.outputs.counts }}
  snippet: \${{ jobs.show.outputs.snippet }}
  pics: \${{ jobs.show.outputs.pics }}
  view: \${{ jobs.show.outputs.view }}
`

const loaded = loadWorkflow(RENDERED_YAML, 'rendered.workflow.yaml')
if (!loaded.def) throw new Error('renderedRun fixture: the rendered workflow no longer parses')

const definition = loaded.def.raw

export const RENDERED_RUN_ID = 'run_01hellofixturerendered0000'

/** 2026-08-26T12:00:00Z — every stamp below is an offset from it, in ms. */
const T0 = Date.UTC(2026, 7, 26, 12, 0, 0)
const at = (ms: number) => T0 + ms

const RUN_PREFIX = `workflows/hello/rendered/runs/${RENDERED_RUN_ID}`
const STEP_PREFIX = `${RUN_PREFIX}/show/0/render`

const WORDS = [
  { text: 'Hello, world!', start: 0 },
  { text: 'Hello, studio!', start: 2 },
]

const COUNTS = [
  { line: 'Hello, world!', chars: 13 },
  { line: 'Hello, studio!', chars: 14 },
]

const SNIPPET = "const line = 'Hello, world!'\nconsole.log(line)\n"

function picSvg(label: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
    '<rect width="320" height="180" fill="#101828"/>' +
    `<text x="160" y="96" fill="#ffffff" font-size="20" text-anchor="middle">${label}</text>` +
    '</svg>'
  )
}

function pic(index: number, label: string): { ref: FileRef; text: string } {
  const path = `${STEP_PREFIX}/pic-${index}.svg`
  const text = picSvg(label)
  return {
    ref: {
      path,
      name: `pic-${index}.svg`,
      contentType: 'image/svg+xml',
      size: text.length,
      // Same-origin, root-relative — the serve route `ImagesView` requires (Task 15's `isSameOriginUrl`).
      url: fileUrl(path),
    },
    text,
  }
}

const PIC_0 = pic(0, 'world')
const PIC_1 = pic(1, 'studio')
const PICS = [PIC_0.ref, PIC_1.ref]

/** The bytes a bucket would hold for the two pics; `mocks/db.ts` seeds these into `db.files`. */
export const RENDERED_RUN_FILES: { path: string; text: string; contentType: string }[] = [
  { path: PIC_0.ref.path, text: PIC_0.text, contentType: 'image/svg+xml' },
  { path: PIC_1.ref.path, text: PIC_1.text, contentType: 'image/svg+xml' },
]

const VIEW = { line: 'Hello, world!', index: 0 }

const RECORDED_OUTPUTS = { words: WORDS, counts: COUNTS, snippet: SNIPPET, pics: PICS, view: VIEW }

const run: RunRow = {
  runId: RENDERED_RUN_ID,
  impl: 'hello',
  workflow: 'rendered',
  workflowName: 'Rendered outputs',
  workflowVersion: '0.0.0',
  definition,
  yaml: RENDERED_YAML,
  inputs: {},
  status: 'succeeded',
  headless: false,
  startedBy: 'user_mock',
  startedAt: T0,
  finishedAt: at(2_000),
  leaseOwner: null,
  leaseUntil: null,
  outputs: RECORDED_OUTPUTS,
  annotations: [],
}

const steps: StepRow[] = [
  {
    runId: RENDERED_RUN_ID,
    key: 'show/0/render',
    job: 'show',
    index: 0,
    step: 'render',
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 1,
    inputs: { path: 'render', body: {} },
    response: { initial: RECORDED_OUTPUTS },
    outputs: RECORDED_OUTPUTS,
    error: null,
    summary: null,
    annotations: [],
    startedAt: at(500),
    finishedAt: at(1_500),
    heartbeatAt: null,
  },
]

export const RENDERED_RUN: { run: RunRow; steps: StepRow[] } = { run, steps }
