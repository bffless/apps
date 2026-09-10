/**
 * Task 17: every named renderer (`transcript`, `chart`, `code`, `images`,
 * `island`) has to reach the screen from a *replayed* run through
 * `RunOutputs`, not just through `ValueView`'s own direct dispatch tests —
 * and `island` needs `impl`, which `RunOutputs` now takes as an explicit
 * prop rather than only reading off `ImplContext` (so this test renders with
 * no `ImplContext.Provider` at all, proving the prop path alone is enough).
 *
 * The M1 `FINISHED_RUN` fixture declares no `render` on any of its outputs,
 * so it's the negative case: `RunOutputs` still renders it (via replay) with
 * zero `.value-renderer-badge`s and zero `[data-testid="renderer"]`s.
 */
import { http, HttpResponse } from 'msw'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { RENDERED_RUN } from '../../mocks/fixtures/renderedRun'
import { replayRun } from '../../lib/runner/replay'
import { FRAME_URL, FRAMES_DEF, framesRun } from '../../test/framesRun'
import type { RunState } from '../../lib/runner/types'
import { RunOutputs } from './RunOutputs'

// jsdom has no canvas (`ChartView.test.tsx` explains why); this test only
// needs to know `render: chart` reaches `ChartView`, not that uPlot can
// actually draw into a headless DOM — hence the shared inert stub.
vi.mock('uplot', async () => (await import('../../test/uplotMock')).inertUPlot())

describe('RunOutputs', () => {
  /**
   * 2026-09-09 UX review: "if I want to get to the next input, I have to
   * scroll like a frickin' mile". Every output with a body is a disclosure,
   * closed, so the pane is a list of names you can scan — and the closed row
   * has to say what the value is without being opened.
   */
  it('lists outputs closed, each row naming what the value is, and Expand all opens them', () => {
    const def = toDefinition(RENDERED_RUN.run.definition)
    const state = replayRun(RENDERED_RUN.run, RENDERED_RUN.steps, def)

    const { container } = render(<RunOutputs def={def} state={state} impl={state.impl} />)
    const runScope = container.querySelector('.output-group[data-scope="run"]') as HTMLElement

    const rows = within(runScope).getAllByTestId('value-row')
    expect(rows.length).toBeGreaterThan(0)
    // Closed by default, and every closed row carries a name and a summary.
    expect(rows.every((row) => !(row as HTMLDetailsElement).open)).toBe(true)
    for (const row of rows) {
      expect(row.querySelector('.value-label')?.textContent).toBeTruthy()
      expect(row.querySelector('.value-brief')?.textContent).toBeTruthy()
    }

    fireEvent.click(screen.getByTestId('values-expand-all'))
    expect(within(runScope).getAllByTestId('value-row').every((row) => (row as HTMLDetailsElement).open)).toBe(
      true,
    )

    // ...and back, so a value opened by hand rejoins the group on the next press.
    fireEvent.click(screen.getByTestId('values-expand-all'))
    expect(
      within(runScope).getAllByTestId('value-row').every((row) => !(row as HTMLDetailsElement).open),
    ).toBe(true)
  })

  /**
   * The reason `valuesOpen.ts` carries an epoch at all: a row opened by hand
   * has to rejoin the group on the next bulk press, or "Collapse all" quietly
   * means "collapse all except the ones you touched".
   */
  it('closes a hand-opened row on the next Collapse all', () => {
    const def = toDefinition(RENDERED_RUN.run.definition)
    const state = replayRun(RENDERED_RUN.run, RENDERED_RUN.steps, def)

    const { container } = render(<RunOutputs def={def} state={state} impl={state.impl} />)
    const runScope = container.querySelector('.output-group[data-scope="run"]') as HTMLElement
    const [first] = within(runScope).getAllByTestId('value-row') as HTMLDetailsElement[]

    fireEvent.click(first!.querySelector('summary') as HTMLElement)
    expect(first!.open).toBe(true)

    // Expand all — everything opens, including the one already open.
    fireEvent.click(screen.getByTestId('values-expand-all'))
    expect(within(runScope).getAllByTestId('value-row').every((r) => (r as HTMLDetailsElement).open)).toBe(true)

    // Collapse all — and the hand-opened one closes with the rest.
    fireEvent.click(screen.getByTestId('values-expand-all'))
    expect(within(runScope).getAllByTestId('value-row').every((r) => !(r as HTMLDetailsElement).open)).toBe(
      true,
    )
  })

  /**
   * Round 4 broke this and nothing at the pane level would have caught it: the
   * bar took the *foldable* count and printed it as the pane's size, so five
   * outputs read as two. The component's own suite pins the two numbers in
   * isolation; this pins them against a real pane.
   */
  it('labels the bar with every output, while only the foldable ones are rows', () => {
    const def = toDefinition(RENDERED_RUN.run.definition)
    const state = replayRun(RENDERED_RUN.run, RENDERED_RUN.steps, def)

    const { container } = render(<RunOutputs def={def} state={state} impl={state.impl} />)
    const runScope = container.querySelector('.output-group[data-scope="run"]') as HTMLElement

    const declared = Object.keys(def.outputs ?? {}).length
    expect(declared).toBeGreaterThan(within(runScope).getAllByTestId('value-row').length)
    expect(screen.getByTestId('values-expand-all').previousSibling).toHaveTextContent(
      `${declared} outputs`,
    )
  })

  it('never folds an island: a closed live surface is simply not there', () => {
    server.use(
      http.get('/w/hello/islands/line-viewer.html', () =>
        HttpResponse.text('<!doctype html><p>viewer</p>'),
      ),
    )
    const def = toDefinition(RENDERED_RUN.run.definition)
    const state = replayRun(RENDERED_RUN.run, RENDERED_RUN.steps, def)

    const { container } = render(<RunOutputs def={def} state={state} impl={state.impl} />)
    const runScope = container.querySelector('.output-group[data-scope="run"]') as HTMLElement
    const island = within(runScope).getByTestId('island-frame')
    expect(island.closest('[data-testid="value-row"]')).toBeNull()
  })

  it('renders all five named renderers from a replayed run, with no ImplContext and no badge', () => {
    server.use(
      http.get('/w/hello/islands/line-viewer.html', () =>
        HttpResponse.text('<!doctype html><p>viewer</p>'),
      ),
    )

    const def = toDefinition(RENDERED_RUN.run.definition)
    const state = replayRun(RENDERED_RUN.run, RENDERED_RUN.steps, def)

    const { container } = render(<RunOutputs def={def} state={state} impl={state.impl} />)

    // The run's own outputs section (`[data-scope="run"]`) — not the per-job
    // section below it, which re-shows the same five values off the step row.
    const runScope = container.querySelector('.output-group[data-scope="run"]')
    expect(runScope).not.toBeNull()
    const renderers = within(runScope as HTMLElement).getAllByTestId('renderer')
    expect(renderers.map((el) => el.getAttribute('data-render')).sort()).toEqual(
      ['chart', 'code', 'images', 'island', 'transcript'].sort(),
    )
    expect(within(runScope as HTMLElement).queryAllByText(/^renderer:/)).toHaveLength(0)
    expect(within(runScope as HTMLElement).getByTestId('island-frame')).toBeInTheDocument()
  })

  // The run-level `poster_view` of `interactive.workflow.yaml` (M3 Task 10):
  // a `json` output declared `render: island` whose recorded value happens to
  // be a File ref. The "a bare json output holding a File ref is a file"
  // inference is for declarations that name *no* renderer — one that does said
  // what it wants drawn, and a file card is not it.
  it('keeps a named renderer on a json output whose recorded value is a File ref', () => {
    server.use(
      http.get('/w/hello/islands/line-viewer.html', () =>
        HttpResponse.text('<!doctype html><p>viewer</p>'),
      ),
    )

    const def = toDefinition({
      spec: 1,
      name: 'Poster view',
      jobs: {},
      outputs: {
        poster_view: {
          type: 'json',
          value: '${{ jobs.card.outputs.poster }}',
          render: 'island',
          src: 'islands/line-viewer.html',
        },
      },
    })
    const state = {
      outputs: {
        poster_view: {
          path: 'workflows/hello/interactive/runs/run_1/poster.svg',
          name: 'poster.svg',
          contentType: 'image/svg+xml',
          size: 399,
          url: '/api/uploads/workflows/hello/interactive/runs/run_1/poster.svg',
        },
      },
    } as unknown as RunState

    render(<RunOutputs def={def} state={state} impl="hello" />)

    expect(screen.getByTestId('renderer')).toHaveAttribute('data-render', 'island')
  })

  // The other half of the same rule, pinned so the fix above cannot be widened
  // into "never infer": a declaration that names **no** renderer still learns
  // it is a file from its value, which is how every bare
  // `poster: ${{ steps.draw.outputs.poster }}` gets its Download.
  it('still infers a file card for a bare json output whose value is a File ref', () => {
    const def = toDefinition({
      spec: 1,
      name: 'Poster',
      jobs: {},
      outputs: { poster: '${{ jobs.card.outputs.poster }}' },
    })
    const state = {
      outputs: {
        poster: {
          path: 'workflows/hello/interactive/runs/run_1/poster.svg',
          name: 'poster.svg',
          contentType: 'image/svg+xml',
          size: 399,
          url: '/api/uploads/workflows/hello/interactive/runs/run_1/poster.svg',
        },
      },
    } as unknown as RunState

    const { container } = render(<RunOutputs def={def} state={state} impl="hello" />)

    expect(screen.queryByTestId('renderer')).toBeNull()
    expect(container.querySelector('.file-card-download')).not.toBeNull()
    // The tag beside the label reports the *inferred* type, not the resolved `json`.
    expect(screen.getByText('file')).toBeInTheDocument()
  })

  it('still renders the M1 fixture, with no badge, through the same component', () => {
    const def = toDefinition(FINISHED_RUN.run.definition)
    const state = replayRun(FINISHED_RUN.run, FINISHED_RUN.steps, def)

    render(<RunOutputs def={def} state={state} impl={state.impl} />)

    expect(screen.getByTestId('run-outputs')).toBeInTheDocument()
    expect(document.querySelectorAll('.value-renderer-badge')).toHaveLength(0)
    expect(screen.queryAllByTestId('renderer')).toHaveLength(0)
  })
})

/**
 * apps#446: a run-level markdown output that follows to a step's declaration
 * reads that step's `images` map off the persisted rows.
 */
describe('RunOutputs — a followed markdown output draws through its images map (apps#446)', () => {
  it('rewrites the zip-relative path to the serve url', () => {
    const { container } = render(<RunOutputs def={FRAMES_DEF} state={framesRun()} />)
    expect(container.querySelector('[data-output="post"] .markdown-view img')?.getAttribute('src')).toBe(FRAME_URL)
  })
})
