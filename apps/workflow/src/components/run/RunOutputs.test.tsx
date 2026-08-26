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
import { render, screen, within } from '@testing-library/react'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { RENDERED_RUN } from '../../mocks/fixtures/renderedRun'
import { replayRun } from '../../lib/runner/replay'
import { RunOutputs } from './RunOutputs'

// jsdom has no canvas (`ChartView.test.tsx` explains why); this test only
// needs to know `render: chart` reaches `ChartView`, not that uPlot can
// actually draw into a headless DOM.
vi.mock('uplot', () => {
  class MockUPlot {
    static paths = { bars: () => undefined }
    destroy() {}
  }
  return { default: MockUPlot }
})

describe('RunOutputs', () => {
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

  it('still renders the M1 fixture, with no badge, through the same component', () => {
    const def = toDefinition(FINISHED_RUN.run.definition)
    const state = replayRun(FINISHED_RUN.run, FINISHED_RUN.steps, def)

    render(<RunOutputs def={def} state={state} impl={state.impl} />)

    expect(screen.getByTestId('run-outputs')).toBeInTheDocument()
    expect(document.querySelectorAll('.value-renderer-badge')).toHaveLength(0)
    expect(screen.queryAllByTestId('renderer')).toHaveLength(0)
  })
})
