/**
 * TEST-ONLY. The Studio `blog` job's shape in miniature (apps#446): a
 * pipeline step whose `srcs` output maps `frame:<t>` tokens to captured
 * frames, an island step whose markdown `post` declares that map as its
 * `images`, and a script step that re-homes the images onto zip-relative
 * paths and maps *those* off its own `srcs` output. Shared by the image-map,
 * StepPane and RunOutputs suites.
 */
import { loadWorkflow } from '../lib/runner/definition'
import type { Definition, RunState } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'

export const FRAME_PATH = 'workflows/frames/frames/runs/run_1/blog/0/frames/frames/0/frame-01.jpg'
export const FRAME_URL = `/api/uploads/${FRAME_PATH}`

const YAML = `
name: frames
on: { manual: { inputs: { note: { type: string } } } }
jobs:
  blog:
    steps:
      - id: frames
        uses: pipeline
        with: { path: video/frames, body: { note: "\${{ inputs.note }}" } }
        outputs:
          srcs: { type: json, value: "\${{ response.result.srcs }}" }
      - id: review
        uses: island
        with: { src: islands/blog-editor.html, post: "\${{ inputs.note }}" }
        outputs:
          post: { type: markdown, images: "\${{ steps.frames.outputs.srcs }}" }
          plain: { type: markdown }
      - id: bundle
        uses: script
        with: { src: scripts/blog-bundle.js, markdown: "\${{ steps.review.outputs.post }}" }
        outputs:
          post: { type: markdown, images: "\${{ steps.bundle.outputs.srcs }}" }
          srcs: { type: json }
    outputs:
      post: \${{ steps.bundle.outputs.post }}
      draft: \${{ steps.review.outputs.post }}
outputs:
  post: \${{ jobs.blog.outputs.post }}
`

export const REVIEW_POST = [
  '![The diff](frame:78)',
  '',
  '![Never captured](frame:99)',
  '',
  '![Elsewhere](images/a.jpg)',
].join('\n')

export const BUNDLE_POST = '![The diff](images/frame-01.jpg)'

const loaded = loadWorkflow(YAML, 'frames.workflow.yaml')
if (!loaded.ok || !loaded.def) {
  throw new Error(`frames fixture does not lint: ${JSON.stringify(loaded.findings)}`)
}
export const FRAMES_DEF = loaded.def as Definition

export const FRAMES_KEY = stepKey('blog', 0, 'frames')
export const REVIEW_KEY = stepKey('blog', 0, 'review')
export const BUNDLE_KEY = stepKey('blog', 0, 'bundle')

/** A finished run of the fixture, as a replay would hold it. */
export function framesRun(): RunState {
  return {
    runId: 'run_1',
    impl: 'frames',
    workflow: 'frames',
    status: 'succeeded',
    headless: false,
    unattended: false,
    inputs: { note: 'hi' },
    steps: {
      [FRAMES_KEY]: {
        key: FRAMES_KEY, job: 'blog', index: 0, stepId: 'frames', kind: 'pipeline',
        status: 'succeeded', attempt: 1, annotations: [],
        outputs: { srcs: { 'frame:78': FRAME_PATH } },
      },
      [REVIEW_KEY]: {
        key: REVIEW_KEY, job: 'blog', index: 0, stepId: 'review', kind: 'island',
        status: 'succeeded', attempt: 1, annotations: [],
        outputs: { post: REVIEW_POST, plain: REVIEW_POST },
      },
      [BUNDLE_KEY]: {
        key: BUNDLE_KEY, job: 'blog', index: 0, stepId: 'bundle', kind: 'script',
        status: 'succeeded', attempt: 1, annotations: [],
        outputs: { post: BUNDLE_POST, srcs: { 'images/frame-01.jpg': FRAME_PATH } },
      },
    },
    expansions: {},
    annotations: [],
    outputs: { post: BUNDLE_POST },
    startedAt: 1_000,
  }
}
