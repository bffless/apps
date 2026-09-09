/**
 * Fix round 1, finding 1: `uiSlice.selectedStep` is process-global, step keys
 * repeat identically across runs of the same workflow (`<job>/<index>/
 * <step>`, no `runId` component), and `RunShell` never remounts across a
 * run-to-run navigation (react-router keeps the same component instance for
 * a `:runId` param change — there is no `key` forcing a fresh one). Left
 * unhandled, a selection made on one run survives onto the next and blocks
 * *that* run's own waiting-step auto-select (Task 18's `!selectedStep`
 * guard).
 *
 * `createMemoryRouter` + `RouterProvider` (built from the same `routes`
 * `App` renders, `src/routes.tsx`) is used instead of `<MemoryRouter initialEntries>` because the
 * latter fixes its history at mount — it cannot simulate a real in-app
 * navigation the way `router.navigate(...)` can, and the whole point here is
 * that `RunShell` does *not* remount between the two runs.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { createMemoryRouter, createRoutesFromElements, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { routes } from '../../routes'
import { seedFinishedRun } from '../../mocks/db'
import { FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { resetHelloHarness, startHelloAtConfirmWaiting } from '../../test/helloHarness'

afterEach(() => {
  resetHelloHarness()
})

/** One job's node on the Summary graph — the graph's only clickable unit (Task 8). */
function node(page: HTMLElement, job: string): HTMLElement | null {
  return (
    within(page)
      .getAllByTestId('job')
      .find((el) => el.getAttribute('data-job') === job) ?? null
  )
}

/** From the Summary: the step's job node, then the step's own row on the job page. */
function openStep(page: HTMLElement, key: string) {
  fireEvent.click(node(page, key.split('/')[0]!)!)
  fireEvent.click(page.querySelector(`[data-testid="step"][data-key="${key}"]`) as HTMLElement)
}

describe('RunShell — selection is scoped to the run being viewed', () => {
  it('resets a selection made on one run when navigating to another, so the new run’s own waiting step still auto-selects', async () => {
    seedFinishedRun() // Run A: finished, read-only.
    const { store, runId: runBId } = await startHelloAtConfirmWaiting() // Run B: live, confirm/0/review waiting.

    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/hello/hello/runs/${FIXTURE_RUN_ID}`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )

    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')

    // A step is selected on Run A — its job's node, then its row on the trail.
    openStep(page, 'slow/0/start')
    expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
    // No chip carries `aria-pressed` any more — the selection is Run A's own
    // URL now.
    expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/slow/0`)
    expect(router.state.location.search).toBe('?step=slow%2F0%2Fstart')

    // Navigate to Run B — the same `RunShell` instance, only the `:runId`
    // param changes (no remount, no `key`).
    await act(async () => {
      await router.navigate(`/hello/hello/runs/${runBId}`)
    })

    // Run B's own waiting step auto-selects — the stale selection from Run A
    // (`slow/0/start`, a key that also exists on Run B, just not `waiting`)
    // must not have survived the navigation and blocked it.
    await waitFor(() => {
      expect(within(page).getByLabelText(/^approved/)).toBeChecked()
    })
    expect(within(page).getByRole('button', { name: 'Finish' })).toBeInTheDocument()
    expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'running')
  })
})

/**
 * Final review, finding 1: `ui.hoveredValue` is the same process-global,
 * step-key-repeats-across-runs shape `selectedStep` is (fix round 1, finding
 * 1) — a hover left over from the run just navigated away from would light up
 * a graph chip on the new run that never produced it. The existing `[runId]`
 * effect that clears `selectedStep` is where this rides along.
 */
describe('RunShell — hoveredValue is scoped to the run being viewed', () => {
  it('clears a hovered value from one run when navigating to another', async () => {
    seedFinishedRun() // Run A: finished, read-only.
    const { store, runId: runBId } = await startHelloAtConfirmWaiting() // Run B: live.

    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/hello/hello/runs/${FIXTURE_RUN_ID}`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )

    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')

    // Hover an output value on Run A — scoped to the open row's body, since
    // the job page's own disclosure carries an Input | Output tablist too.
    openStep(page, 'slow/0/start')
    const pane = within(page).getByTestId('step-pane')
    fireEvent.click(within(pane).getByRole('tab', { name: 'Output' }))
    const wrapper = within(pane).getByText('poster').closest('.value')!
    fireEvent.mouseEnter(wrapper)
    expect(store.getState().ui.hoveredValue).not.toBeNull()

    // Navigate to Run B — the same `RunShell` instance, only the `:runId`
    // param changes (no remount, no `key`) — without ever firing `mouseleave`.
    await act(async () => {
      await router.navigate(`/hello/hello/runs/${runBId}`)
    })

    expect(store.getState().ui.hoveredValue).toBeNull()
  })
})
