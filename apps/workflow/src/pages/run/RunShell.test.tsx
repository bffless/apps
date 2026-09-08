import { render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import App from '../../App'
import { resetDb, seedFinishedRun } from '../../mocks/db'
import { FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { makeStore } from '../../store'

afterEach(() => resetDb())

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
})
