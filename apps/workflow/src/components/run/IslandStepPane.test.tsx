/**
 * The island step's pane (Task 5, 08: "the pane is the island").
 *
 * The pane is the only place a DOM element exists for an island step, so it is
 * also the only place the middleware's handle can actually be mounted: these
 * tests prove the pane finds its handle by run + step key, hands the real
 * iframe to it, and reflects the display mode the store holds — plus the
 * `RunPage` half, where fullscreen collapses the graph to a strip.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../../App'
import { server } from '../../mocks/server'
import type { AppStore } from '../../store'
import { useAppSelector } from '../../store/hooks'
import { islandDisplayChanged } from '../../store/uiSlice'
import {
  ISLAND_DEF,
  ISLAND_KEY,
  flush,
  resetIslandHarness,
  startIslandRun,
} from '../../test/islandHarness'
import { IslandStepPane } from './IslandStepPane'
import { StepPane } from './StepPane'

beforeEach(() => {
  // The live path never reads this — a call means the page regressed.
  server.use(http.get('/api/workflow/run', () => HttpResponse.json({ run: null, steps: [] })))
})

afterEach(() => {
  resetIslandHarness()
})

/**
 * `IslandStepPane` takes the run state as a prop, so a bare `render` would
 * freeze it at the state of the moment — exactly what `RunPage` never does.
 * This mirrors the page: the state comes off the slice on every render.
 */
function LivePane() {
  const state = useAppSelector((s) => s.run.state)
  if (!state) return null
  return <IslandStepPane def={ISLAND_DEF} state={state} stepKey={ISLAND_KEY} />
}

function renderPane(store: AppStore) {
  return render(
    <Provider store={store}>
      <LivePane />
    </Provider>,
  )
}

describe('IslandStepPane', () => {
  it('mounts the handle on its own iframe and shows the declared title', async () => {
    const { store, host } = await startIslandRun()
    renderPane(store)

    expect(screen.getByTestId('island-step')).toBeInTheDocument()
    expect(screen.getByText('Pick one')).toBeInTheDocument()

    const frame = screen.getByTestId('island-frame')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts')

    await waitFor(() => expect(host.mounts).toHaveLength(1))
    expect(host.frames[0]).toBe(frame)
    expect(host.mounts[0].arguments).toEqual({ mode: 'quick' })

    host.settle()
    await waitFor(() =>
      expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting'),
    )
  })

  it('reflects the store display mode on island-display and tears down on unmount', async () => {
    const { store, host } = await startIslandRun()
    const { unmount } = renderPane(store)

    await waitFor(() => expect(host.mounts).toHaveLength(1))
    host.settle()
    await flush()

    expect(screen.getByTestId('island-display')).toHaveAttribute('data-mode', 'inline')

    store.dispatch(islandDisplayChanged('fullscreen'))
    await waitFor(() =>
      expect(screen.getByTestId('island-display')).toHaveAttribute('data-mode', 'fullscreen'),
    )
    expect(host.displayModes.at(-1)).toBe('fullscreen')

    unmount()
    await waitFor(() => expect(host.teardowns).toContain('unmounted'))
    // The step keeps its state — the record is unchanged; re-selecting re-mounts.
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting')
  })

  it('lists a dynamic annotation as step-annotated', async () => {
    const { store, host } = await startIslandRun()
    renderPane(store)

    await waitFor(() => expect(host.mounts).toHaveLength(1))
    host.settle()
    await flush()

    host.deps!.onAnnotate({ annotations: [{ level: 'warning', message: 'two takes overlap' }] })

    await waitFor(() => expect(screen.getAllByTestId('step-annotated')).toHaveLength(1))
    expect(screen.getByText('two takes overlap')).toBeInTheDocument()
  })
})

describe('StepPane — island delegation', () => {
  it('delegates a live running/waiting island to the island pane, and falls back to tabs read-only', async () => {
    const { store, host } = await startIslandRun()
    const state = store.getState().run.state!

    const live = render(
      <Provider store={store}>
        <StepPane def={ISLAND_DEF} state={state} stepKey={ISLAND_KEY} live />
      </Provider>,
    )
    expect(screen.getByTestId('island-step')).toBeInTheDocument()
    await waitFor(() => expect(host.mounts.length).toBeGreaterThan(0))
    live.unmount()

    render(
      <Provider store={store}>
        <StepPane def={ISLAND_DEF} state={state} stepKey={ISLAND_KEY} live={false} />
      </Provider>,
    )
    expect(screen.queryByTestId('island-step')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Input' })).toBeInTheDocument()
  })
})

describe('RunPage — island fullscreen', () => {
  it('collapses the graph to a strip and comes back on exit', async () => {
    const { store, runId, host } = await startIslandRun()

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/test/island/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    const page = screen.getByRole('main')
    // A loading island is auto-selected the same way a waiting step is — its
    // pane is what mounts it (Decision 11).
    await waitFor(() => expect(within(page).getByTestId('island-frame')).toBeInTheDocument())
    host.settle()
    await waitFor(() =>
      expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting'),
    )

    expect(within(page).getAllByTestId('step').length).toBeGreaterThan(0)
    expect(document.querySelector('.island-fullscreen')).toBeNull()

    store.dispatch(islandDisplayChanged('fullscreen'))

    await waitFor(() => expect(document.querySelector('.island-fullscreen')).not.toBeNull())
    expect(within(page).getByTestId('island-display')).toHaveAttribute('data-mode', 'fullscreen')
    // The graph is gone; the strip is what is left of it.
    expect(within(page).queryAllByTestId('step')).toHaveLength(0)

    fireEvent.click(within(page).getByTestId('island-exit-fullscreen'))

    await waitFor(() => expect(document.querySelector('.island-fullscreen')).toBeNull())
    expect(store.getState().ui.islandDisplay).toBe('inline')
    expect(within(page).getAllByTestId('step').length).toBeGreaterThan(0)
  })
})
