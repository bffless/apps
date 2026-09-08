/**
 * The observe half of the page contract (07/D12).
 *
 * `window.__workflow` is published by the run page on **every** run it shows,
 * headless or not — a driver polls it to follow a run it started, and a run
 * page that stopped publishing would look to it like a run that never
 * progressed. And in a headless run there is nobody to click a chip, so the
 * page keeps an active island mounted by itself: the pane is the only thing
 * that mounts an island (Decision 11), so an island that is never mounted is
 * a run that hangs. While the selection follows the run that is the pane;
 * once something has pinned it elsewhere (apps#452) it is the **backstage** —
 * mounted out of sight, the selection untouched.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import {
  MemoryRouter,
  createMemoryRouter,
  createRoutesFromElements,
  RouterProvider,
} from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../../App'
import { publishWorkflowGlobal } from '../../lib/workflowGlobal'
import { seedFinishedRun } from '../../mocks/db'
import { FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { server } from '../../mocks/server'
import { routes } from '../../routes'
import { makeStore } from '../../store'
import { newRunId } from '../../lib/runner/ids'
import { startRun } from '../../store/runnerActions'
import { runEvent, runOpened } from '../../store/runSlice'
import { flush, pumpUntil as pumpClock, REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting, trackedHelloStore } from '../../test/helloHarness'
import { islandStore, pumpUntil, resetIslandHarness } from '../../test/islandHarness'
import type { FakeIslandHost } from '../../test/islandHarness'
import type { Definition, StepKey } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'

afterEach(() => {
  resetHelloHarness()
  resetIslandHarness()
  publishWorkflowGlobal(null)
})

// ---------------------------------------------------------------------------
// window.__workflow
// ---------------------------------------------------------------------------

describe('RunPage — window.__workflow', () => {
  beforeEach(() => {
    server.use(http.get('/api/workflow/run', () => HttpResponse.json({ run: null, steps: [] })))
  })

  it('publishes the live run, and clears it when the page goes away', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    const view = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/hello/hello/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    await waitFor(() => expect(window.__workflow).toBeDefined())
    const published = window.__workflow!
    expect(published.runId).toBe(runId)
    expect(published.status).toBe('running')
    // A waiting form is an active step: this is what a driver watches for.
    expect(published.currentSteps).toContain(REVIEW_KEY)
    expect(published.steps[REVIEW_KEY]).toBe('waiting')
    expect(published.steps['greet/0/say']).toBe('succeeded')
    expect(published.outputs).toEqual({})

    view.unmount()
    expect(window.__workflow).toBeUndefined()
  })

  it('keeps up with the run: the outputs land on it when the run finishes', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/hello/hello/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    const page = screen.getByRole('main')
    await waitFor(() => expect(window.__workflow?.status).toBe('running'))

    fireEvent.click(await within(page).findByRole('button', { name: 'Finish' }))

    await waitFor(() => expect(window.__workflow?.status).toBe('succeeded'))
    expect(window.__workflow?.currentSteps).toEqual([])
    expect(Object.keys(window.__workflow?.outputs ?? {}).sort()).toEqual([
      'lines',
      'poster',
      'report',
    ])
  })
})

describe('RunPage — window.__workflow on a parked run (07 `wait=park`)', () => {
  /**
   * Parking takes the lease, so the tab is no longer `live` and the page falls
   * through to the run **record** — which a tab that drove the run never
   * fetched. The global must read `parked` anyway, and the moment the park
   * lands: it is what tells the driver to stop waiting and hand the run to a
   * person. The record is withheld outright here (the `run` read answers
   * `null`, so the page renders "No such run") because that is the strongest
   * form of the same question — publishing off the record would leave a driver
   * with nothing at all.
   */
  it('publishes `parked` off the slice, without waiting for the record', async () => {
    server.use(http.get('/api/workflow/run', () => HttpResponse.json({ run: null, steps: [] })))

    const def = toDefinition({
      name: 'Park',
      jobs: {
        confirm: {
          steps: [
            { id: 'review', uses: 'form', with: { title: 'Review', fields: { note: { type: 'string' } }, submit: 'Approve' } },
          ],
        },
      },
    }) as Definition
    const { store, advance } = trackedHelloStore()
    const runId = newRunId()
    store.dispatch(runOpened({ meta: { def, yaml: '# park\n', workflowName: 'Park', park: true } }))
    store.dispatch(
      runEvent({
        type: 'run.started',
        runId,
        impl: 'hello',
        workflow: 'park',
        inputs: {},
        headless: true,
        unattended: false,
        at: Date.now(),
      }),
    )
    await flush()
    await pumpClock(advance, () => store.getState().run.mode === 'parked', { maxSteps: 200 })

    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/hello/park/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    await waitFor(() => expect(window.__workflow?.status).toBe('parked'))
    expect(window.__workflow?.runId).toBe(runId)
    // The step the person is being handed, still where the driver left it.
    expect(window.__workflow?.steps[REVIEW_KEY]).toBe('waiting')
  })
})

describe('RunPage — window.__workflow on a replayed run', () => {
  it('publishes a finished run this tab never drove, off the replayed state', async () => {
    seedFinishedRun()
    const store = makeStore()
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/hello/hello/runs/${FIXTURE_RUN_ID}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')
    await waitFor(() => expect(window.__workflow?.status).toBe('succeeded'))
    expect(window.__workflow?.runId).toBe(FIXTURE_RUN_ID)
    expect(window.__workflow?.currentSteps).toEqual([])
    expect(window.__workflow?.steps[REVIEW_KEY]).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// Headless island mounting
// ---------------------------------------------------------------------------

const ISLAND_YAML = 'name: Island\n'

/** Two islands, one after the other in a single job — both headless-safe. */
const islandStep = (id: string) => ({
  id,
  uses: 'island',
  with: { src: `islands/${id}.html`, title: id, mode: 'quick' },
  outputs: { choice: { type: 'string' } },
  headless: 'auto',
})

const TWO_ISLANDS_DEF = toDefinition({
  name: 'Island',
  jobs: { a: { steps: [islandStep('x'), islandStep('y')] } },
}) as Definition

/** The same two islands, each saying `auto-accept: true` for itself (07, apps#435). */
const TWO_AUTO_ACCEPT_ISLANDS_DEF = toDefinition({
  name: 'Island',
  jobs: {
    a: {
      steps: [
        { ...islandStep('x'), 'auto-accept': true },
        { ...islandStep('y'), 'auto-accept': true },
      ],
    },
  },
}) as Definition

const X_KEY: StepKey = stepKey('a', 0, 'x')
const Y_KEY: StepKey = stepKey('a', 0, 'y')

/**
 * One island that declares `display: fullscreen` (04), in a job called `pick`
 * so its row's key is the `pick/0/choose` a driver reads — the shape the
 * fullscreen strip has to name.
 */
const FULLSCREEN_ISLAND_DEF = toDefinition({
  name: 'Island',
  jobs: {
    pick: {
      steps: [
        {
          id: 'choose',
          name: 'Pick the best line',
          uses: 'island',
          with: { src: 'islands/pick.html', title: 'Pick one', display: 'fullscreen', mode: 'quick' },
          outputs: { choice: { type: 'string' } },
        },
      ],
    },
  },
}) as Definition

const CHOOSE_KEY: StepKey = stepKey('pick', 0, 'choose')

/**
 * The same fullscreen island, preceded by a plain one in the same job — so
 * the follow logic's own sequential auto-open (`note` running, then `choose`
 * once `note` finishes) leaves *two* rows open on `pick`'s page, exactly as a
 * person reading a multi-step job would (fix round 3, finding 2).
 */
const FULLSCREEN_TWO_STEP_DEF = toDefinition({
  name: 'Island',
  jobs: {
    pick: {
      steps: [
        islandStep('note'),
        {
          id: 'choose',
          name: 'Pick the best line',
          uses: 'island',
          with: { src: 'islands/pick.html', title: 'Pick one', display: 'fullscreen', mode: 'quick' },
          outputs: { choice: { type: 'string' } },
        },
      ],
    },
  },
}) as Definition

const NOTE_KEY: StepKey = stepKey('pick', 0, 'note')

/**
 * A matrix job whose one step is an island — for fix round 3, finding 3: the
 * collect view (`/job/pick`, no `:index`) renders no step rows at all, so a
 * `?step=` naming item 0's step must not be read as "on this page" the way it
 * would be for a plain job's bare route.
 */
const MATRIX_ISLAND_DEF = toDefinition({
  name: 'Island',
  jobs: {
    pick: {
      strategy: { matrix: { who: ['a', 'b'] }, 'max-parallel': 1 },
      steps: [islandStep('choose')],
    },
  },
}) as Definition

const MATRIX_CHOOSE_KEY: StepKey = stepKey('pick', 0, 'choose')

type Driving = { headless?: boolean; unattended?: boolean }

async function startIslands(
  driving: Driving,
  def: Definition = TWO_ISLANDS_DEF,
  first: StepKey = X_KEY,
) {
  const { store, advance, host } = islandStore()
  store.dispatch(
    startRun({
      impl: 'test',
      workflow: 'island',
      def,
      yaml: ISLAND_YAML,
      workflowName: 'Island',
      values: {},
      ...driving,
    }),
  )
  await pumpUntil(advance, () => store.getState().run.state?.steps[first]?.status === 'running')
  return { store, advance, host, runId: store.getState().run.state!.runId }
}

const startTwoIslands = (driving: Driving, def?: Definition) => startIslands(driving, def)

describe('RunPage — headless island mounting', () => {
  beforeEach(() => {
    server.use(http.get('/api/workflow/run', () => HttpResponse.json({ run: null, steps: [] })))
  })

  /**
   * Drives `x` to `succeeded` so `y` starts, then moves the selection onto the
   * finished `x` — a `?step=` navigation, which **pins** the selection there
   * (apps#452), so nothing may re-open `y` in the pane. In a headless run
   * that would be a hang — unless `y` is mounted somewhere else.
   */
  async function driveToSecondIsland(driving: Driving, def?: Definition) {
    const { store, host, runId } = await startTwoIslands(driving, def)
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/test/island/runs/${runId}`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )

    // `x` is auto-selected and mounted, then submits and finishes; `y` starts
    // and takes the pane in its turn.
    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(X_KEY))
    host.settle()
    await waitFor(() => expect(store.getState().run.state!.steps[X_KEY].status).toBe('waiting'))
    host.allDeps[0]!.onSubmit({ choice: 'a' })
    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(Y_KEY))
    expect(store.getState().run.state!.steps[Y_KEY].status).toBe('running')

    // Something moves the selection onto the finished `x`.
    await act(async () => {
      await router.navigate(`/test/island/runs/${runId}?step=${X_KEY}`)
    })
    return { store, host }
  }

  /**
   * `y` is mounted backstage — a frame in the document, outside the pane —
   * and driven to completion from there; the selection stays on `x`.
   */
  async function expectDrivenBackstage(store: ReturnType<typeof makeStore>, host: FakeIslandHost) {
    const backstage = await screen.findByTestId('island-backstage')
    const frame = within(backstage).getByTestId('island-frame')
    expect(frame).toBeInTheDocument()
    expect(screen.getByTestId('step-pane')).not.toContainElement(frame)
    expect(store.getState().ui.selectedStep).toBe(X_KEY)
    expect(screen.getByTestId('run-follow')).toHaveAttribute('data-state', 'off')

    await waitFor(() => expect(host.pending()).toBe(1))
    expect(host.mounts.at(-1)!.headless).toBe(true)
    host.settle()
    await waitFor(() => expect(store.getState().run.state!.steps[Y_KEY].status).toBe('waiting'))
    expect(host.allDeps[1]!.onSubmit({ choice: 'b' })).toEqual({ ok: true })
    await waitFor(() => expect(store.getState().run.state!.status).toBe('succeeded'))
    expect(store.getState().ui.selectedStep).toBe(X_KEY)
    expect(screen.queryByTestId('island-backstage')).not.toBeInTheDocument()
  }

  it('keeps the active island mounted backstage when the selection lands on a finished step', async () => {
    const { store, host } = await driveToSecondIsland({ headless: true })

    await expectDrivenBackstage(store, host)
  })

  it('keeps the active island mounted backstage in an unattended run too (07, apps#432)', async () => {
    // "Don't wait for me": the person asked not to be waited for, so a
    // `headless: auto` island is kept mounted the way a headless run would —
    // told it is driving itself, and out of the pane they pinned.
    const { store, host } = await driveToSecondIsland({ unattended: true })

    await expectDrivenBackstage(store, host)
  })

  it('keeps an island whose own step said `auto-accept` mounted backstage, on an otherwise interactive run (07, apps#435)', async () => {
    // Nobody ticked "Don't wait for me" — the step itself asked to self-drive,
    // so it is kept mounted like an unattended one; the run's flags stay off.
    const { store, host } = await driveToSecondIsland({}, TWO_AUTO_ACCEPT_ISLANDS_DEF)

    await expectDrivenBackstage(store, host)
    expect(store.getState().run.state).toMatchObject({ headless: false, unattended: false })
  })

  it('leaves an interactive run’s selection exactly where the person put it, and its island to its chip', async () => {
    const { store, host } = await driveToSecondIsland({})

    // Pinned, and `y` waits for a person: no re-claim, and no backstage either —
    // mounting it hidden would only have it reload under them when they open it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.getState().ui.selectedStep).toBe(X_KEY)
    expect(screen.queryByTestId('island-backstage')).not.toBeInTheDocument()
    expect(host.pending()).toBe(0)
    expect(store.getState().run.state!.steps[Y_KEY].status).toBe('running')
  })

  it('opens the first active island with no selection at all, in a headless run', async () => {
    const { store, runId } = await startTwoIslands({ headless: true })
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/test/island/runs/${runId}`]}>
          <App />
        </MemoryRouter>
      </Provider>,
    )

    await waitFor(() => expect(screen.getByTestId('island-frame')).toBeInTheDocument())
    expect(store.getState().ui.selectedStep).toBe(X_KEY)
  })

  it('Expand overlays the open island row and the strip names the step; Esc exits', async () => {
    // The island opens **in its row** on the job page (phase 3), and Expand
    // fixes that row's body over the viewport with the strip in the content
    // column's place — the strip's crumb naming the two levels above it and
    // the row's own step key.
    const { store, host, runId } = await startIslands({}, FULLSCREEN_ISLAND_DEF, CHOOSE_KEY)
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/test/island/runs/${runId}`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )
    const page = screen.getByRole('main')

    // Following claims the loading island: its row on `pick`'s page, expanded.
    await waitFor(() => expect(within(page).getByTestId('island-frame')).toBeInTheDocument())
    expect(router.state.location.pathname).toBe(`/test/island/runs/${runId}/job/pick/0`)
    expect(within(page).getByTestId('step')).toHaveAttribute('data-key', CHOOSE_KEY)
    host.settle()
    await waitFor(() => expect(store.getState().run.state!.steps[CHOOSE_KEY].status).toBe('waiting'))

    fireEvent.click(within(page).getByRole('button', { name: 'Expand' }))

    expect(document.querySelector('.run-canvas.island-fullscreen')).toBeTruthy()
    const strip = within(page).getByTestId('island-strip')
    expect(strip).toHaveTextContent(CHOOSE_KEY)
    // `Run › <job label> › <step label>`, the first two a way up.
    expect(within(strip).getByRole('button', { name: 'Run' })).toBeInTheDocument()
    expect(within(strip).getByRole('button', { name: 'pick' })).toBeInTheDocument()
    expect(strip).toHaveTextContent('Pick the best line')
    // The overlay holds the row's body and nothing else: the job head, the
    // job's values and every sibling row are hidden while the canvas carries
    // `island-fullscreen` (fix round 1, finding 3). The hiding is CSS —
    // `.island-fullscreen .job-page > .job-head, .island-fullscreen .job-io,
    // .island-fullscreen .step-row:not([data-open])` in `src/index.css` — and
    // jsdom does not compute the stylesheet, so the class on the canvas is
    // what this asserts; the elements are deliberately still mounted, so the
    // row is not remounted when the overlay closes.
    expect(within(page).getByTestId('job-head')).toBeInTheDocument()
    expect(within(page).getByTestId('job-io')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(document.querySelector('.run-canvas.island-fullscreen')).toBeNull()
    // Same frame, still mounted: leaving the overlay is a mode change, not a remount.
    expect(within(page).getByTestId('island-display')).toBeInTheDocument()
    expect(host.mounts).toHaveLength(1)
  })

  it('marks only the open island’s row `data-fullscreen`, leaving a second open row hidden (fix round 3, finding 2)', async () => {
    // `note` runs and finishes first, auto-opening its row; `choose` then
    // takes the pane in its turn — Decision 7 never closes `note`'s row on
    // that move, so both are open together by the time Expand is clicked.
    const { store, host, runId } = await startIslands({}, FULLSCREEN_TWO_STEP_DEF, NOTE_KEY)
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/test/island/runs/${runId}`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )
    const page = screen.getByRole('main')

    await waitFor(() => expect(within(page).getByTestId('island-frame')).toBeInTheDocument())
    host.settle()
    await waitFor(() => expect(store.getState().run.state!.steps[NOTE_KEY].status).toBe('waiting'))
    host.allDeps[0]!.onSubmit({ choice: 'x' })
    // `choose`'s own mount, once the middleware launches it.
    await waitFor(() => expect(host.mounts).toHaveLength(2))
    host.settle()
    await waitFor(() => expect(store.getState().run.state!.steps[CHOOSE_KEY].status).toBe('waiting'))
    // Both rows are still open — `note`'s from its own turn in the pane,
    // `choose`'s from this one — Decision 7 never closed the first on the move.
    expect(within(page).getAllByTestId('step-pane')).toHaveLength(2)

    fireEvent.click(within(page).getByRole('button', { name: 'Expand' }))
    expect(document.querySelector('.run-canvas.island-fullscreen')).toBeTruthy()

    const noteRow = page.querySelector(`[data-testid="step"][data-key="${NOTE_KEY}"]`)!.closest('li')!
    const chooseRow = page.querySelector(`[data-testid="step"][data-key="${CHOOSE_KEY}"]`)!.closest('li')!
    expect(chooseRow).toHaveAttribute('data-fullscreen')
    expect(noteRow).not.toHaveAttribute('data-fullscreen')
    // Both rows stayed open — the marker, not `data-open`, is what the
    // overlay's CSS now keys its "everything else" rule off.
    expect(noteRow).toHaveAttribute('data-open')
    expect(chooseRow).toHaveAttribute('data-open')
  })

  it('leaves the overlay when the strip’s crumb climbs out of the row', async () => {
    const { store, host, runId } = await startIslands({}, FULLSCREEN_ISLAND_DEF, CHOOSE_KEY)
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/test/island/runs/${runId}`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )
    const page = screen.getByRole('main')
    await waitFor(() => expect(within(page).getByTestId('island-frame')).toBeInTheDocument())
    host.settle()
    await waitFor(() => expect(store.getState().run.state!.steps[CHOOSE_KEY].status).toBe('waiting'))
    fireEvent.click(within(page).getByRole('button', { name: 'Expand' }))
    expect(document.querySelector('.run-canvas.island-fullscreen')).toBeTruthy()

    // The job crumb is a person's move: it pins, and the overlay goes with the
    // row it was fixed over.
    fireEvent.click(within(within(page).getByTestId('island-strip')).getByRole('button', { name: 'pick' }))

    await waitFor(() => expect(document.querySelector('.run-canvas.island-fullscreen')).toBeNull())
    expect(router.state.location.pathname).toBe(`/test/island/runs/${runId}/job/pick/0`)
    expect(router.state.location.search).toBe('')
    expect(store.getState().ui.islandDisplay).toBe('inline')
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'off')
  })
})

/**
 * Fix round 3, finding 3: `rowOnThisPage` used to read "no `:index` on the
 * route" as item 0's leg — true for a plain job, but a *matrix* job's bare
 * route is the collect view, which renders no step rows at all. A `?step=`
 * naming item 0's step on that URL left the island neither in a row (there is
 * none) nor backstage (it looked, wrongly, like the pane already had it) —
 * stuck at `running` with nobody driving it.
 */
describe('RunPage — a matrix job’s collect view never claims an island', () => {
  it('sends item 0’s island backstage rather than treating the collect view as its row', async () => {
    const { store, host, runId } = await startIslands({ unattended: true }, MATRIX_ISLAND_DEF, MATRIX_CHOOSE_KEY)
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/test/island/runs/${runId}`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )
    const page = screen.getByRole('main')
    await waitFor(() => expect(within(page).getByTestId('island-frame')).toBeInTheDocument())
    expect(router.state.location.pathname).toBe(`/test/island/runs/${runId}/job/pick/0`)

    // A `?step=` naming item 0's step, but on the collect route (no
    // `:index`) — the shape `rowOnThisPage`'s bug read as "item 0's page".
    await act(async () => {
      await router.navigate(`/test/island/runs/${runId}/job/pick?step=${encodeURIComponent(MATRIX_CHOOSE_KEY)}`)
    })

    // The collect view, rowless — nothing on the job page itself can show
    // the island (it is not absent from `page` outright: the backstage div
    // asserted below renders inside the same `.run-canvas`).
    const jobPage = within(page).getByTestId('job-page')
    expect(within(jobPage).getByTestId('job-items')).toBeInTheDocument()
    expect(within(jobPage).queryByTestId('step-pane')).not.toBeInTheDocument()
    expect(within(jobPage).queryByTestId('island-frame')).not.toBeInTheDocument()

    const backstage = await screen.findByTestId('island-backstage')
    expect(within(backstage).getByTestId('island-frame')).toBeInTheDocument()
    expect(host.mounts.at(-1)!.headless).toBe(true)
  })
})
