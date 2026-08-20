/**
 * The workflow screen (08): the definition graph, the way into a run, and the
 * runs already behind it — and, for a workflow that does not validate, the lint
 * report *without* a way to start one (08's "no Start" rule).
 */
import { render, screen, within } from '@testing-library/react'
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

function renderApp(path = '/hello/hello') {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('WorkflowPage', () => {
  it('renders the definition graph and the way into a run', async () => {
    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText('Hello workflow')).toBeInTheDocument()
    expect(await within(page).findAllByTestId('job')).toHaveLength(4)
    expect(within(page).getByRole('link', { name: 'Start a run' })).toHaveAttribute(
      'href',
      '/hello/hello/run',
    )
    expect(within(page).getByRole('link', { name: 'View workflow file' })).toHaveAttribute(
      'href',
      '/hello/hello/file',
    )
  })

  it('lists the most recent runs with their status', async () => {
    seedFinishedRun()
    renderApp()

    const page = screen.getByRole('main')
    const link = await within(page).findByRole('link', { name: new RegExp(FIXTURE_RUN_ID) })
    expect(link).toHaveAttribute('href', `/hello/hello/runs/${FIXTURE_RUN_ID}`)
    expect(within(page).getByText('Succeeded')).toHaveAttribute('data-state', 'succeeded')
  })

  it('reports the lint errors and offers no Start when the workflow does not validate', async () => {
    server.use(http.get(YAML_URL, () => HttpResponse.text('spec: 1\nname: broken\njobs: 42\n')))

    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText('must be object')).toBeInTheDocument()
    expect(within(page).queryByRole('link', { name: 'Start a run' })).not.toBeInTheDocument()
    expect(within(page).queryByTestId('job')).not.toBeInTheDocument()
    expect(within(page).getByRole('link', { name: 'View workflow file' })).toBeInTheDocument()
  })
  it('reports an unknown workflow id with a link back to the implementation', async () => {
    renderApp('/hello/nope')

    const page = screen.getByRole('main')
    expect(await within(page).findByText('No such workflow')).toBeInTheDocument()
    // Not `..`: under the pathless Shell layout route that resolves to `/`.
    expect(within(page).getByRole('link', { name: 'Back to its workflows' })).toHaveAttribute(
      'href',
      '/hello',
    )
  })
})
