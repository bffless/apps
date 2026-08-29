/**
 * The transcript → player wiring end to end through the two panes that scope
 * it (Task 15, apps#380): clicking a `render: transcript` segment moves the
 * `FileCard` player shown *in the same scope*, and nothing outside it.
 *
 * `MediaSeekContext.test.tsx` covers the registry itself; this file covers the
 * thing the registry exists for — that `RunOutputs`' run-scope provider and
 * `StepPane`'s Output-tab provider actually put a transcript and a player in
 * one scope, with a real `ValueView` dispatch in between. The renderer fixture
 * (`mocks/fixtures/renderedRun.ts`) has a transcript but no video, so this
 * suite carries its own two-output run instead of growing the shared one.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { Provider } from 'react-redux'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it } from 'vitest'
import { RunOutputs } from './RunOutputs'
import { StepPane } from './StepPane'
import { FileCard } from '../values/FileCard'
import { MediaSeekProvider } from '../values/MediaSeekContext'
import { TranscriptView } from '../values/renderers/TranscriptView'
import { fileUrl } from '../../lib/coerce'
import { loadWorkflow } from '../../lib/runner/definition'
import { replayRun } from '../../lib/runner/replay'
import type { RunRow, StepRow } from '../../lib/runner/rows'
import { makeStore } from '../../store'

const YAML = `spec: 1
name: Talk
description: A transcript and the clip it transcribes.

on:
  manual: {}

jobs:
  show:
    steps:
      - id: play
        uses: pipeline
        with: { path: play, body: {} }
        outputs:
          words: { type: json, value: "\${{ response.words }}", render: transcript }
          clip:  { type: file, value: "\${{ response.clip }}" }
    outputs:
      words: \${{ steps.play.outputs.words }}
      clip: \${{ steps.play.outputs.clip }}

outputs:
  words: \${{ jobs.show.outputs.words }}
  clip: \${{ jobs.show.outputs.clip }}
`

const loaded = loadWorkflow(YAML, 'talk.workflow.yaml')
if (!loaded.def) throw new Error('mediaSeek fixture: the talk workflow no longer parses')

const RUN_ID = 'run_01hellofixturemediaseek000'
const T0 = Date.UTC(2026, 7, 26, 12, 0, 0)
const CLIP_PATH = `workflows/hello/talk/runs/${RUN_ID}/show/0/play/clip.mp4`

const OUTPUTS = {
  words: [
    { text: 'Hello there', start: 0 },
    { text: 'General Kenobi', start: 65, speaker: 'Obi-Wan' },
  ],
  clip: {
    path: CLIP_PATH,
    name: 'clip.mp4',
    contentType: 'video/mp4',
    size: 1024,
    // Same-origin and root-relative, or `FileCard` renders no player at all.
    url: fileUrl(CLIP_PATH),
  },
}

const run: RunRow = {
  runId: RUN_ID,
  impl: 'hello',
  workflow: 'talk',
  workflowName: 'Talk',
  workflowVersion: '0.0.0',
  definition: loaded.def.raw,
  yaml: YAML,
  inputs: {},
  status: 'succeeded',
  headless: false,
  startedBy: 'user_mock',
  startedAt: T0,
  finishedAt: T0 + 2_000,
  leaseOwner: null,
  leaseUntil: null,
  outputs: OUTPUTS,
  annotations: [],
}

const steps: StepRow[] = [
  {
    runId: RUN_ID,
    key: 'show/0/play',
    job: 'show',
    index: 0,
    step: 'play',
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 1,
    inputs: { path: 'play', body: {} },
    response: { initial: OUTPUTS },
    outputs: OUTPUTS,
    error: null,
    summary: null,
    annotations: [],
    startedAt: T0 + 500,
    finishedAt: T0 + 1_500,
    heartbeatAt: null,
  },
]

function replayed() {
  const def = toDefinition(run.definition)
  return { def, state: replayRun(run, steps, def) }
}

/** The one `<video>` a `FileCard` renders for the clip. */
function player(container: HTMLElement): HTMLVideoElement {
  const el = container.querySelector('.file-card video')
  expect(el, 'the clip output rendered no player').not.toBeNull()
  return el as HTMLVideoElement
}

describe('transcript → FileCard seek', () => {
  it("moves the run-scope player when a segment in RunOutputs' own scope is clicked", () => {
    const { def, state } = replayed()
    const { container } = render(<RunOutputs def={def} state={state} impl={state.impl} />)

    const video = player(container)
    expect(video.currentTime).toBe(0)

    fireEvent.click(screen.getByText('[1:05] Obi-Wan: General Kenobi'))

    expect(video.currentTime).toBe(65)
  })

  it("moves the step's own player from the Output tab's transcript", () => {
    const { def, state } = replayed()
    const { container } = render(
      <Provider store={makeStore()}>
        <StepPane def={def} state={state} stepKey="show/0/play" live={false} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))

    const video = player(container)
    fireEvent.click(screen.getByText('[0:00] Hello there'))

    expect(video.currentTime).toBe(0)

    fireEvent.click(screen.getByText('[1:05] Obi-Wan: General Kenobi'))
    expect(video.currentTime).toBe(65)
  })

  it('stops seeking once the player leaves the scope, without breaking the transcript', () => {
    // `FileCard` registers from a `ref` callback, so removing the card has to
    // unregister it — otherwise the provider keeps seeking a detached element
    // and the click looks like it worked when nothing moved.
    function Scope() {
      const [showClip, setShowClip] = useState(true)
      return (
        <MediaSeekProvider>
          {showClip && <FileCard refValue={OUTPUTS.clip} />}
          <TranscriptView value={OUTPUTS.words} />
          <button type="button" onClick={() => setShowClip(false)}>
            hide clip
          </button>
        </MediaSeekProvider>
      )
    }

    const { container } = render(<Scope />)
    const video = player(container)

    fireEvent.click(screen.getByText('[1:05] Obi-Wan: General Kenobi'))
    expect(video.currentTime).toBe(65)

    fireEvent.click(screen.getByRole('button', { name: 'hide clip' }))
    expect(container.querySelector('.file-card video')).toBeNull()

    // The segment is still clickable; it just has nothing to move.
    fireEvent.click(screen.getByText('[0:00] Hello there'))
    expect(video.currentTime).toBe(65)
  })
})
