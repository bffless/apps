/**
 * The live run page (Task 18, 08): rendered straight off the run slice while
 * this tab is the one driving it — proven at `hello`'s own `confirm/0/review`
 * waiting point (Task 17's scenario-2 harness, lifted into
 * `src/test/helloHarness.ts`).
 *
 * `GET /api/workflow/run` is stubbed for the whole suite to answer "nothing
 * here" and to count its own calls — the exact shape of the race the live
 * path exists to survive (Task 17's write-ahead persistence means the row a
 * `GET` issued right after `run.started` navigates here would read may not
 * have landed yet). If the live path ever regresses into depending on that
 * read, every test below fails on "No such run", a stuck "Loading…", or a
 * non-zero call count — never a false pass.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import {
  MemoryRouter,
  RouterProvider,
  createMemoryRouter,
  createRoutesFromElements,
} from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../../App'
import { server } from '../../mocks/server'
import { routes } from '../../routes'
import type { AppStore } from '../../store'
import { runPaused } from '../../store/runSlice'
import { REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting } from '../../test/helloHarness'

let getRunCalls = 0

beforeEach(() => {
  getRunCalls = 0
  server.use(
    http.get('/api/workflow/run', () => {
      getRunCalls++
      return HttpResponse.json({ run: null, steps: [] })
    }),
  )
})

afterEach(() => {
  resetHelloHarness()
})

function renderLive(store: AppStore, runId: string) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/hello/hello/runs/${runId}`]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

/** One job's node on the Summary graph — the graph's only clickable unit (Task 8). */
function node(page: HTMLElement, job: string): HTMLElement | null {
  return (
    within(page)
      .getAllByTestId('job')
      .find((el) => el.getAttribute('data-job') === job) ?? null
  )
}

/**
 * The step-pane's own `StatusPill` — the `data-state` contract holds there
 * too, and it is what a step's own pane (rather than the graph, which is the
 * Summary's and draws jobs only) has to show it.
 */
function stepPanePill(page: HTMLElement): HTMLElement {
  return within(page).getByTestId('step-pane').querySelector('.pill') as HTMLElement
}

describe('RunShell — live', () => {
  it('renders off the slice with no server read, auto-selects the waiting form, and finishes the run on submit', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    renderLive(store, runId)

    const page = screen.getByRole('main')

    // The race this page exists to survive: never "no such run", never stuck
    // loading, and — the strongest form of the claim — the server read this
    // page used to depend on never happens at all.
    expect(within(page).queryByText('No such run')).not.toBeInTheDocument()
    expect(within(page).queryByText('Loading…')).not.toBeInTheDocument()
    expect(getRunCalls).toBe(0)

    expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'running')

    // A waiting form step is auto-selected — first by topo order — with no
    // click at all. The auto-follow effect has already navigated to its
    // job/step route (the graph is the Summary's now), so the `data-state`
    // contract is read off the step-pane's own status pill.
    expect(stepPanePill(page)).toHaveAttribute('data-state', 'waiting')
    expect(within(page).getByLabelText(/^approved/)).toBeChecked()
    const submit = within(page).getByRole('button', { name: 'Finish' })
    expect(submit).toBeInTheDocument()

    fireEvent.click(submit)

    // A finished run, still following, returns to the Summary (08) — so by
    // the time the header settles on `succeeded` the graph is back too, and
    // the form's own job node carries the same `succeeded` the chip did.
    await waitFor(() => {
      expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')
      expect(node(page, 'confirm')).toHaveAttribute('data-state', 'succeeded')
    })
    expect(getRunCalls).toBe(0)
  })

  it('opens the waiting form’s row on its job page while following, and the form is the row body', async () => {
    // Phase 3's shape (spec §Step rows): following does not open a pane beside
    // a graph any more — it navigates to the step's *job page* and expands the
    // one row `?step=` names, whose body **is** the form.
    const { store, runId } = await startHelloAtConfirmWaiting()
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/hello/hello/runs/${runId}`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )
    const page = screen.getByRole('main')

    await within(page).findByTestId('form-step')
    expect(router.state.location.pathname).toBe(`/hello/hello/runs/${runId}/job/confirm/0`)
    expect(router.state.location.search).toBe(`?step=${encodeURIComponent(REVIEW_KEY)}`)

    // `confirm` has one step, so the job page has one row — and it is open.
    const row = within(page).getByTestId('step')
    expect(row).toHaveAttribute('data-key', REVIEW_KEY)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(
      within(within(page).getByTestId('step-pane')).getByTestId('form-step'),
    ).toBeInTheDocument()

    fireEvent.click(within(page).getByRole('button', { name: 'Finish' }))

    await waitFor(() =>
      expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded'),
    )
    // Following: a finished run returns to the Summary.
    expect(router.state.location.pathname).toBe(`/hello/hello/runs/${runId}`)
    expect(await within(page).findByTestId('run-outputs')).toBeInTheDocument()
  })

  describe('the persistence-pause banner (05, apps#375)', () => {
    it('shows the pause message with a Retry, and Retry re-adopts the run from its record', async () => {
      // This suite stubs `GET /api/workflow/run` to "nothing here"; Retry
      // genuinely re-reads the record, so that stub is dropped for this test.
      server.resetHandlers()
      const { store, runId } = await startHelloAtConfirmWaiting()
      renderLive(store, runId)
      const page = screen.getByRole('main')
      expect(within(page).queryByTestId('run-paused')).not.toBeInTheDocument()

      act(() => {
        store.dispatch(runPaused('Could not save step confirm/0/review'))
      })

      const banner = within(page).getByTestId('run-paused')
      expect(banner).toHaveAttribute('role', 'alert')
      expect(banner).toHaveTextContent('Could not save step confirm/0/review')

      fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }))

      await waitFor(() => {
        expect(within(page).queryByTestId('run-paused')).not.toBeInTheDocument()
      })
      expect(store.getState().run.mode).toBe('live')
      expect(store.getState().run.state?.runId).toBe(runId)
      expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'running')
      expect(stepPanePill(page)).toHaveAttribute('data-state', 'waiting')
    })
  })
})
