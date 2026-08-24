/**
 * Fix round 1, finding 1: `uiSlice.selectedStep` is process-global, step keys
 * repeat identically across runs of the same workflow (`<job>/<index>/
 * <step>`, no `runId` component), and `RunPage` never remounts across a
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
 * that `RunPage` does *not* remount between the two runs.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { createMemoryRouter, createRoutesFromElements, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { routes } from '../routes'
import { seedFinishedRun } from '../mocks/db'
import { FIXTURE_RUN_ID } from '../mocks/fixtures/finishedRun'
import { resetHelloHarness, startHelloAtConfirmWaiting } from '../test/helloHarness'

afterEach(() => {
  resetHelloHarness()
})

function chip(page: HTMLElement, key: string): HTMLElement | null {
  return (
    within(page)
      .getAllByTestId('step')
      .find((el) => el.getAttribute('data-key') === key) ?? null
  )
}

describe('RunPage — selection is scoped to the run being viewed', () => {
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

    // A step is selected on Run A.
    fireEvent.click(chip(page, 'slow/0/start')!)
    expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
    expect(chip(page, 'slow/0/start')).toHaveAttribute('aria-pressed', 'true')

    // Navigate to Run B — the same `RunPage` instance, only the `:runId`
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
