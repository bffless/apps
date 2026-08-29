/**
 * The Kickoff page (08): wires `KickoffForm` to discovery, the lint report a
 * broken workflow gets instead of a form (Task 14's rule), Re-run prefill via
 * `?from=`, and `startRun` + navigation on submit.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from '../App'
import { db, seedFinishedRun } from '../mocks/db'
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

    // Navigated to the new run's own page — rendered live, straight off the
    // run slice (Task 18), never depending on the row Task 17's middleware
    // may still be mid-write on. The old expectation here ("No such run")
    // was exactly the race Task 18 closes: a `GET` issued this early can
    // land before the row's own `create`, and reporting that as "no such
    // run" would invent a fact the server never gave us.
    expect(await within(page).findByTestId('run-status')).toHaveAttribute('data-state', 'running')
    expect(within(page).queryByText('No such run')).not.toBeInTheDocument()
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

describe('KickoffPage — "Don\'t wait for me" (07)', () => {
  it('starts the run unattended when the toggle is ticked, and the row records it apart from headless', async () => {
    // hello's `review` form declares `headless: skip`, so the toggle is offered.
    const { page, store } = renderApp()
    const form = await within(page).findByTestId('kickoff-form')

    fireEvent.click(within(form).getByTestId('kickoff-unattended'))
    fireEvent.click(within(form).getByTestId('kickoff-start'))

    const run = store.getState().run.state!
    expect(run.unattended).toBe(true)
    expect(run.headless).toBe(false)
    // Not an input.
    expect(run.inputs).toEqual({ greeting: 'Hello', names: ['world'], photo: null, shout: false })

    await waitFor(() => expect(db.runs.get(run.runId)).toBeDefined())
    expect(db.runs.get(run.runId)).toMatchObject({ unattended: true, headless: false })
    expect(await within(page).findByTestId('run-unattended')).toBeInTheDocument()
  })

  it('starts an ordinary run when the toggle is left alone', async () => {
    const { page, store } = renderApp()
    const form = await within(page).findByTestId('kickoff-form')

    fireEvent.click(within(form).getByTestId('kickoff-start'))

    expect(store.getState().run.state!.unattended).toBe(false)
  })
})
