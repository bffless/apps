/**
 * Past runs (08): the table, its client-side status filter (Decision 6), and
 * the two ways out of a row — the run itself, and a re-run pre-filled from it.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from '../App'
import { seedFinishedRun } from '../mocks/db'
import { FIXTURE_RUN_ID } from '../mocks/fixtures/finishedRun'
import { server } from '../mocks/server'
import { makeStore } from '../store'

function renderApp(path = '/hello/hello/runs') {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

const fixtureRow = () => new RegExp(FIXTURE_RUN_ID)

describe('RunsPage', () => {
  it('lists a past run with its status, duration and outputs', async () => {
    seedFinishedRun()
    renderApp()

    const page = screen.getByRole('main')
    const row = await within(page).findByRole('row', { name: fixtureRow() })

    expect(within(row).getByText('Succeeded')).toHaveAttribute('data-state', 'succeeded')
    expect(within(row).getByText('user_fixture')).toBeInTheDocument()
    expect(within(row).getByText('12.5 s')).toBeInTheDocument()
    expect(within(row).getByText(/poster\.png/)).toBeInTheDocument()

    expect(within(row).getByRole('link', { name: FIXTURE_RUN_ID })).toHaveAttribute(
      'href',
      `/hello/hello/runs/${FIXTURE_RUN_ID}`,
    )
    expect(within(row).getByRole('link', { name: 'Re-run' })).toHaveAttribute(
      'href',
      `/hello/hello/run?from=${FIXTURE_RUN_ID}`,
    )
  })

  it('filters the table by status', async () => {
    seedFinishedRun()
    renderApp()

    const page = screen.getByRole('main')
    await within(page).findByRole('row', { name: fixtureRow() })

    fireEvent.change(within(page).getByLabelText('Status'), { target: { value: 'failed' } })

    expect(within(page).queryByRole('row', { name: fixtureRow() })).not.toBeInTheDocument()
    expect(within(page).getByText('No runs with that status')).toBeInTheDocument()
  })

  it('tells a failed read apart from a workflow that has never run', async () => {
    seedFinishedRun()
    server.use(
      http.get('/api/workflow/runs', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )

    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText("Couldn't load runs")).toBeInTheDocument()
    expect(within(page).queryByText('No runs yet')).not.toBeInTheDocument()
    expect(within(page).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('says so when the workflow has never run', async () => {
    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText('No runs yet')).toBeInTheDocument()
  })
})
