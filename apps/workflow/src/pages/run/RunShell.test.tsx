import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import {
  MemoryRouter,
  RouterProvider,
  createMemoryRouter,
  createRoutesFromElements,
} from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import App from '../../App'
import { resetDb, seedFinishedRun } from '../../mocks/db'
import { FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { server } from '../../mocks/server'
import { routes } from '../../routes'
import { makeStore } from '../../store'
import { resetHelloHarness, startHelloAtConfirmWaiting } from '../../test/helloHarness'

afterEach(() => {
  resetDb()
  resetHelloHarness()
})

function renderAt(path: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('RunShell', () => {
  it('renders the run header and the run card on the Summary route, with the run rail instead of the implementation tree', async () => {
    seedFinishedRun()
    renderAt(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')
    expect(within(page).getByTestId('run-pane')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Run' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Implementations' })).not.toBeInTheDocument()
  })

  it('redirects an old `?step=` on the Summary URL to the job page, keeping the step', async () => {
    seedFinishedRun()
    renderAt(`/hello/hello/runs/${FIXTURE_RUN_ID}?step=slow%2F0%2Fstart`)
    const page = screen.getByRole('main')
    await within(page).findByTestId('step-pane')
    expect(within(page).getByTestId('job-pane')).toBeInTheDocument()
    expect(within(page).queryByTestId('run-pane')).not.toBeInTheDocument()
  })

  it('pins the step an old `?step=` deep link names on a run still in flight, over the waiting form', async () => {
    // The redirect is the shell's, not the Summary page's (fix round 1): a
    // redirect one level down commits after the shell's own follow effects,
    // which would see a run-level URL, decide the selection is free and open
    // the waiting form over the link the person actually followed.
    server.use(http.get('/api/workflow/run', () => HttpResponse.json({ run: null, steps: [] })))
    const { store, runId } = await startHelloAtConfirmWaiting()
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/hello/hello/runs/${runId}?step=slow%2F0%2Fstart`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )
    const page = screen.getByRole('main')

    const pane = await within(page).findByTestId('step-pane')
    expect(within(pane).getByText('slow/0/start')).toBeInTheDocument()
    // The waiting form did not take the pane, and the toggle says so.
    expect(within(page).queryByRole('button', { name: 'Finish' })).not.toBeInTheDocument()
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'off')
    expect(store.getState().ui.follow).toEqual({ runId, on: false })
    expect(router.state.location.pathname).toBe(`/hello/hello/runs/${runId}/job/slow/0`)
    expect(router.state.location.search).toBe('?step=slow%2F0%2Fstart')
  })

  it('pins the run when the rail\'s Summary row is clicked, so follow does not fight it back to the waiting form (fix round 5, finding 2)', async () => {
    server.use(http.get('/api/workflow/run', () => HttpResponse.json({ run: null, steps: [] })))
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

    // Following opens the waiting form's pane on its own.
    await within(page).findByTestId('form-step')

    // A plain `NavLink` click is not, by itself, a person's move (fix round
    // 1's `pageWrote` guard only pins on a non-null selection) — the rail's
    // Summary row names none, so without its own `onNavigate` the auto-open
    // effect above would see follow still on and write the waiting form
    // straight back over it.
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Run' })).getByTestId('rail-summary'))

    expect(router.state.location.pathname).toBe(`/hello/hello/runs/${runId}`)
    expect(within(page).getByTestId('run-pane')).toBeInTheDocument()
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'off')
  })
})
