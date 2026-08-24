/**
 * The Kickoff page (08): wires `KickoffForm` to discovery, the lint report a
 * broken workflow gets instead of a form (Task 14's rule), Re-run prefill via
 * `?from=`, and `startRun` + navigation on submit.
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

const YAML_URL = '/w/hello/.bffless/workflows/hello.workflow.yaml'

function renderApp(path = '/hello/hello/run') {
  const store = makeStore()
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
  return { store, page: screen.getByRole('main') }
}

describe('KickoffPage', () => {
  it('renders the kickoff form for a valid workflow', async () => {
    const { page } = renderApp()
    expect(await within(page).findByTestId('kickoff-form')).toBeInTheDocument()
  })

  it('starts a run in the run slice with the workflow id (not the file name), and navigates to it', async () => {
    const { page, store } = renderApp()
    const form = await within(page).findByTestId('kickoff-form')

    fireEvent.click(within(form).getByTestId('kickoff-start'))

    const run = store.getState().run
    expect(run.state?.runId).toMatch(/^run_/)
    expect(run.state?.status).toBe('running')
    // The regression this guards: `workflow` must be the id ('hello'), never
    // the listing's raw file name ('hello.workflow.yaml').
    expect(run.state?.workflow).toBe('hello')
    expect(run.state?.impl).toBe('hello')
    expect(run.meta?.workflowName).toBe('Hello workflow')
    expect(run.state?.inputs).toEqual({ greeting: 'Hello', names: ['world'], photo: null, shout: false })

    // Navigated to the new run's own page. Task 17 (not this task) persists
    // the row, so at this phase the run page reads it back as unrecorded.
    expect(await within(page).findByText('No such run')).toBeInTheDocument()
  })

  it('reports the lint errors and offers no kickoff form when the workflow does not validate', async () => {
    server.use(http.get(YAML_URL, () => HttpResponse.text('spec: 1\nname: broken\njobs: 42\n')))

    const { page } = renderApp()

    expect(
      await within(page).findByText('This workflow does not validate, so it cannot be run'),
    ).toBeInTheDocument()
    expect(within(page).queryByTestId('kickoff-form')).not.toBeInTheDocument()
  })

  it('prefills the form from a previous run for Re-run, without re-uploading its file', async () => {
    seedFinishedRun()
    const { page } = renderApp(`/hello/hello/run?from=${FIXTURE_RUN_ID}`)

    const form = await within(page).findByTestId('kickoff-form')
    expect(within(form).getByLabelText('studio')).toBeChecked()
  })
})
