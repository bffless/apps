/**
 * The observe half of the page contract (07/D12).
 *
 * `window.__workflow` is published by the run page on **every** run it shows,
 * headless or not — a driver polls it to follow a run it started, and a run
 * page that stopped publishing would look to it like a run that never
 * progressed. And in a headless run there is nobody to click a chip, so the
 * page keeps an active island in the pane by itself: the pane is the only
 * thing that mounts an island (Decision 11), so an island whose pane never
 * opens is a run that hangs.
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
import App from '../App'
import { publishWorkflowGlobal } from '../lib/workflowGlobal'
import { seedFinishedRun } from '../mocks/db'
import { FIXTURE_RUN_ID } from '../mocks/fixtures/finishedRun'
import { server } from '../mocks/server'
import { routes } from '../routes'
import { makeStore } from '../store'
import { startRun } from '../store/runnerActions'
import { REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting } from '../test/helloHarness'
import { islandStore, pumpUntil, resetIslandHarness } from '../test/islandHarness'
import type { Definition, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'

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

type Driving = { headless?: boolean; unattended?: boolean }

async function startTwoIslands(driving: Driving, def: Definition = TWO_ISLANDS_DEF) {
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
  await pumpUntil(advance, () => store.getState().run.state?.steps[X_KEY]?.status === 'running')
  return { store, advance, host, runId: store.getState().run.state!.runId }
}

describe('RunPage — headless island mounting', () => {
  beforeEach(() => {
    server.use(http.get('/api/workflow/run', () => HttpResponse.json({ run: null, steps: [] })))
  })

  /**
   * Drives `x` to `succeeded` so `y` starts, then moves the selection onto the
   * finished `x` — the one shape where the interactive claim-once rule
   * (apps#370) declines to act: `y` has already been claimed, so nothing would
   * re-open it. In a headless run that would be a hang.
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

  it('re-opens the active island when the selection lands on a finished step', async () => {
    const { store } = await driveToSecondIsland({ headless: true })

    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(Y_KEY))
    expect(screen.getByTestId('island-frame')).toBeInTheDocument()
  })

  it('re-opens the active island in an unattended run too (07, apps#432)', async () => {
    // "Don't wait for me": the person asked not to be waited for, so a
    // `headless: auto` island is kept mounted the way a headless run would.
    const { store, host } = await driveToSecondIsland({ unattended: true })

    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(Y_KEY))
    expect(screen.getByTestId('island-frame')).toBeInTheDocument()
    // And the island is told it is driving itself.
    expect(host.mounts.at(-1)!.headless).toBe(true)
  })

  it('re-opens an island whose own step said `auto-accept`, on an otherwise interactive run (07, apps#435)', async () => {
    // Nobody ticked "Don't wait for me" — the step itself asked to self-drive,
    // so it is kept mounted like an unattended one; the run's flags stay off.
    const { store, host } = await driveToSecondIsland({}, TWO_AUTO_ACCEPT_ISLANDS_DEF)

    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(Y_KEY))
    expect(screen.getByTestId('island-frame')).toBeInTheDocument()
    expect(host.mounts.at(-1)!.headless).toBe(true)
    expect(store.getState().run.state).toMatchObject({ headless: false, unattended: false })
  })

  it('leaves an interactive run’s selection exactly where the person put it', async () => {
    const { store } = await driveToSecondIsland({})

    // No re-claim: the person asked for `x`, and `y` was already claimed once.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.getState().ui.selectedStep).toBe(X_KEY)
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
})
