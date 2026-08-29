/**
 * The island step's pane (Task 5, 08: "the pane is the island").
 *
 * The pane is the only place a DOM element exists for an island step, so it is
 * also the only place the middleware's handle can actually be mounted: these
 * tests prove the pane finds its handle by run + step key, hands the real
 * iframe to it, and reflects the display mode the store holds — plus the
 * `RunPage` half, where fullscreen collapses the graph to a strip.
 */
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../../App'
import { analyzeLines } from '../../mocks/analyze'
import { server } from '../../mocks/server'
import type { AppStore } from '../../store'
import { makeStore } from '../../store'
import { useAppSelector } from '../../store/hooks'
import { islandDisplayChanged } from '../../store/uiSlice'
import {
  A_X_KEY,
  A_Y_KEY,
  B_Z_KEY,
  CHOOSE_KEY,
  FORM_AND_ISLAND_DEF,
  FORM_KEY,
  ISLAND_DEF,
  ISLAND_FULLSCREEN_DEF,
  ISLAND_KEY,
  ISLAND_YAML,
  PARALLEL_ISLAND_KEY,
  FORM_AND_TWO_ISLANDS_DEF,
  SAY_KEY,
  flush,
  pumpUntil,
  resetIslandHarness,
  startInteractiveRun,
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
  return <IslandStepPane state={state} stepKey={ISLAND_KEY} />
}

function renderPane(store: AppStore, strict = false) {
  const tree = (
    <Provider store={store}>
      <LivePane />
    </Provider>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
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

  it('leaves the step running when the pane unmounts mid-load', async () => {
    // Fix round 1, finding 1: teardown abandons the in-flight mount. Nothing
    // about that belongs in the run record — the user just looked elsewhere.
    const { store, host } = await startIslandRun()
    const { unmount } = renderPane(store)

    await waitFor(() => expect(host.mounts).toHaveLength(1))
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('running')

    unmount()
    await flush()

    const step = store.getState().run.state!.steps[ISLAND_KEY]
    expect(step.status).toBe('running')
    expect(step.error).toBeUndefined()
    expect(host.teardowns).toContain('unmounted')
  })

  it('reaches waiting once under a StrictMode double-mount, with no ISLAND_LOAD', async () => {
    // `main.tsx` wraps the app in StrictMode, so this is every island's first
    // load in dev: mount → cleanup → mount, the first session abandoned.
    const { store, host } = await startIslandRun()
    renderPane(store, true)

    await waitFor(() => expect(host.mounts.length).toBeGreaterThan(1))
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('running')
    expect(store.getState().run.state!.steps[ISLAND_KEY].error).toBeUndefined()

    host.settle()
    await waitFor(() =>
      expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting'),
    )
    expect(store.getState().run.state!.steps[ISLAND_KEY].error).toBeUndefined()
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
  it('opens a declared fullscreen island inline, expands to the overlay on request, and exits without remounting', async () => {
    // apps#432: `display: fullscreen` is the island's preferred *enlarged*
    // mode, offered as Expand — never its first mount. Nothing here dispatches
    // `islandDisplayChanged`; every move is the person's, through the pane.
    const { store, runId, host } = await startIslandRun(ISLAND_FULLSCREEN_DEF)

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
    const frame = within(page).getByTestId('island-frame')
    host.settle()
    await waitFor(() =>
      expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting'),
    )

    // Inline first: the graph is there, the overlay is not, and Expand is offered.
    await flush()
    expect(document.querySelector('.island-fullscreen')).toBeNull()
    expect(store.getState().ui.islandDisplay).toBe('inline')
    expect(within(page).getByTestId('island-display')).toHaveAttribute('data-mode', 'inline')
    expect(within(page).getAllByTestId('step').length).toBeGreaterThan(0)

    fireEvent.click(within(page).getByTestId('island-expand'))

    await waitFor(() => expect(document.querySelector('.island-fullscreen')).not.toBeNull())
    expect(store.getState().ui.islandDisplay).toBe('fullscreen')
    expect(within(page).getByTestId('island-display')).toHaveAttribute('data-mode', 'fullscreen')
    expect(host.displayModes.at(-1)).toBe('fullscreen')
    // The graph gives way to the strip; Expand is gone while expanded.
    expect(within(page).queryAllByTestId('step')).toHaveLength(0)
    expect(within(page).getByTestId('island-strip')).toBeInTheDocument()
    expect(within(page).queryByTestId('island-expand')).toBeNull()
    // The overlay is the SAME iframe — one mount, one element (edit state survives).
    expect(host.mounts).toHaveLength(1)
    expect(within(page).getByTestId('island-frame')).toBe(frame)

    fireEvent.click(within(page).getByTestId('island-exit-fullscreen'))

    await waitFor(() => expect(document.querySelector('.island-fullscreen')).toBeNull())
    expect(store.getState().ui.islandDisplay).toBe('inline')
    expect(within(page).getAllByTestId('step').length).toBeGreaterThan(0)
    expect(host.mounts).toHaveLength(1)
    expect(within(page).getByTestId('island-frame')).toBe(frame)
    expect(host.teardowns).not.toContain('unmounted')
    // Leaving is not fought back over: nothing re-applies the declaration.
    await flush()
    expect(store.getState().ui.islandDisplay).toBe('inline')

    // Esc is the other way out.
    fireEvent.click(within(page).getByTestId('island-expand'))
    await waitFor(() => expect(store.getState().ui.islandDisplay).toBe('fullscreen'))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(store.getState().ui.islandDisplay).toBe('inline'))
    expect(document.querySelector('.island-fullscreen')).toBeNull()
    expect(host.mounts).toHaveLength(1)
  })

  it('opens an ordinary island inline and resets the mode when the step finishes', async () => {
    const { store, runId, host } = await startIslandRun()

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/test/island/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    const page = screen.getByRole('main')
    await waitFor(() => expect(within(page).getByTestId('island-frame')).toBeInTheDocument())
    host.settle()
    await waitFor(() =>
      expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting'),
    )
    expect(store.getState().ui.islandDisplay).toBe('inline')
    // `inline` never enlarges from the pane's side (04) …
    expect(within(page).queryByTestId('island-expand')).toBeNull()

    // … but the island may still ask for fullscreen, then answers — the mode
    // goes back to inline because the step it belonged to is no longer open.
    host.deps!.onDisplayMode('fullscreen')
    await waitFor(() => expect(document.querySelector('.island-fullscreen')).not.toBeNull())

    host.deps!.onSubmit({ choice: 'a' })
    await waitFor(() => expect(store.getState().ui.islandDisplay).toBe('inline'))
    expect(document.querySelector('.island-fullscreen')).toBeNull()
  })
})

describe('RunPage — a loading island claims the pane', () => {
  /** The graph chip for a step key, the way a user would reach it. */
  function chip(page: HTMLElement, key: string): HTMLElement | undefined {
    return within(page)
      .getAllByTestId('step')
      .find((el) => el.getAttribute('data-key') === key)
  }

  it('opens a starting island over a step the user picked mid-run, and the step reaches waiting', async () => {
    // Fix round 4, finding 1: only the pane mounts an island (Decision 11), so
    // an island whose pane never opens sits at `running` forever — no timeout,
    // no affordance. A click on any other step used to cause exactly that.
    //
    // `analyze` is held open so the click lands while the run is genuinely in
    // flight and the island has not started yet — the exact ordering the bug
    // needed.
    let releaseAnalyze!: () => void
    const analyzing = new Promise<void>((resolve) => {
      releaseAnalyze = resolve
    })
    server.use(
      http.post('/api/hello/analyze', async ({ request }) => {
        const { lines } = (await request.json()) as { lines: unknown }
        await analyzing
        return HttpResponse.json(analyzeLines(lines))
      }),
    )

    const { store, advance, host, runId } = await startInteractiveRun()

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/hello/interactive/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    const page = screen.getByRole('main')
    // The user picks a pipeline step while the run is still in flight.
    await waitFor(() => expect(chip(page, SAY_KEY)).toBeDefined())
    fireEvent.click(chip(page, SAY_KEY)!)
    expect(store.getState().ui.selectedStep).toBe(SAY_KEY)
    await flush()
    // Nothing interactive is loading yet, so the click stands.
    expect(store.getState().ui.selectedStep).toBe(SAY_KEY)

    releaseAnalyze()
    await act(async () => {
      await pumpUntil(
        advance,
        () => store.getState().run.state?.steps[CHOOSE_KEY]?.status === 'running',
        { maxSteps: 400 },
      )
    })

    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(CHOOSE_KEY))
    await waitFor(() => expect(host.mounts).toHaveLength(1))

    // apps#370: the claim happens **once**. A second click away while the
    // island is still loading stands — the page does not re-claim on every
    // click (each re-mount restarted the 30 s ISLAND_LOAD clock, so a hanging
    // island plus a clicking user never timed out). The abandoned mount leaves
    // the step `running`; the chip is the way back.
    fireEvent.click(chip(page, SAY_KEY)!)
    await flush()
    expect(store.getState().ui.selectedStep).toBe(SAY_KEY)
    expect(host.mounts).toHaveLength(1)
    expect(store.getState().run.state!.steps[CHOOSE_KEY].status).toBe('running')

    fireEvent.click(chip(page, CHOOSE_KEY)!)
    await waitFor(() => expect(host.mounts).toHaveLength(2))

    host.settle()
    await waitFor(() =>
      expect(store.getState().run.state!.steps[CHOOSE_KEY].status).toBe('waiting'),
    )
  })

  it('opens the first loading island in scheduling order, not in state-insertion order', async () => {
    // The form owns the pane while `a/x` and `b/z` load unclaimed; `a/y`
    // starts only once `a/x` submits, so the state holds `b/z` before `a/y`.
    // When the form is done, scheduling order says `a/y` (apps#370).
    const { store, host, runId } = await startIslandRun(FORM_AND_TWO_ISLANDS_DEF, A_X_KEY)

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/test/island/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    const page = screen.getByRole('main')
    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(FORM_KEY))
    expect(host.mounts).toHaveLength(0)

    // Hosts are built in launch order: a/x, b/z. A running island accepts a
    // submit whether or not its pane ever opened.
    expect(host.allDeps[0]!.onSubmit({ choice: 'a' })).toEqual({ ok: true })
    await waitFor(() => expect(store.getState().run.state!.steps[A_Y_KEY]?.status).toBe('running'))
    expect(Object.keys(store.getState().run.state!.steps).indexOf(B_Z_KEY)).toBeLessThan(
      Object.keys(store.getState().run.state!.steps).indexOf(A_Y_KEY),
    )

    fireEvent.click(within(page).getByRole('button', { name: 'Finish' }))
    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(A_Y_KEY))
    expect(store.getState().run.state!.steps[B_Z_KEY].status).toBe('running')
  })

  it('never claims the pane on a read-only view — another tab drives that island', async () => {
    // A `running` island in a run this tab does not drive has no pane to open
    // here (StepPane's `live` gate renders the tabs); moving the selection
    // onto it would only yank the reader around (review of apps#370). The
    // reader picks the finished form — a non-interactive selection, the one
    // shape that lets a live page claim.
    const runId = 'run_readonly_island'
    server.use(
      http.get('/api/workflow/run', () =>
        HttpResponse.json({
          run: {
            _id: 1,
            runId,
            impl: 'test',
            workflow: 'island',
            workflowName: 'Island',
            definition: FORM_AND_ISLAND_DEF.raw,
            yaml: ISLAND_YAML,
            inputs: {},
            status: 'running',
            headless: false,
            startedAt: 1_000,
            finishedAt: null,
            outputs: null,
            annotations: [],
          },
          steps: [
            {
              _id: 2,
              runId,
              key: FORM_KEY,
              job: 'ask',
              index: 0,
              step: 'confirm',
              kind: 'form',
              status: 'succeeded',
              attempt: 1,
              outputs: { approved: true },
              annotations: [],
              finishedAt: 1_002,
            },
            {
              _id: 3,
              runId,
              key: PARALLEL_ISLAND_KEY,
              job: 'pick',
              index: 0,
              step: 'choose',
              kind: 'island',
              status: 'running',
              attempt: 1,
              inputs: { mode: 'quick' },
              annotations: [],
              startedAt: 1_001,
            },
          ],
        }),
      ),
    )
    const store = makeStore()

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/test/island/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    const page = screen.getByRole('main')
    await waitFor(() => expect(chip(page, FORM_KEY)).toBeDefined())
    fireEvent.click(chip(page, FORM_KEY)!)
    await flush()

    expect(store.getState().ui.selectedStep).toBe(FORM_KEY)
    expect(within(page).queryByTestId('island-step')).toBeNull()
  })

  it('does not take the pane from a form being filled in', async () => {
    // The case the original `!selectedStep` guard protected, kept: a person
    // mid-interaction outranks an island loading in a parallel job.
    const { store, host, runId } = await startIslandRun(FORM_AND_ISLAND_DEF, PARALLEL_ISLAND_KEY)

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/test/island/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    const page = screen.getByRole('main')
    await waitFor(() => expect(within(page).getByTestId('form-step')).toBeInTheDocument())
    expect(store.getState().ui.selectedStep).toBe(FORM_KEY)

    await flush()
    expect(store.getState().ui.selectedStep).toBe(FORM_KEY)
    expect(within(page).queryByTestId('island-frame')).toBeNull()
    expect(host.mounts).toHaveLength(0)
    // The island stays `running` — the deliberate trade (04/Decision 11): the
    // pane is one, and the person filling in the form owns it.
    expect(store.getState().run.state!.steps[PARALLEL_ISLAND_KEY].status).toBe('running')
  })
})
