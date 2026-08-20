/**
 * "View workflow file" (08): the YAML the implementation published, with the
 * linter's verdict beside it. Mounted as the whole `<App/>` against the MSW
 * backend, so the route, the listing lookup and the fetch are under test too.
 *
 * The two cases that matter are the two the screen exists for: a healthy file
 * still reports its notices, and a file too broken to load must still *render*
 * — a workflow you cannot open is how a bad publish becomes invisible.
 */
import { render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import type { InitialEntry } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from '../App'
import { server } from '../mocks/server'
import { makeStore } from '../store'

const YAML_URL = '/w/hello/.bffless/workflows/hello.workflow.yaml'

function renderApp(entry: InitialEntry) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[entry]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('FilePage', () => {
  it('shows the published YAML with the lint counts and each finding', async () => {
    renderApp('/hello/hello/file')

    const page = screen.getByRole('main')
    expect(await within(page).findByText('name: Hello workflow')).toBeInTheDocument()
    expect(within(page).getByText('0 errors')).toBeInTheDocument()
    expect(within(page).getByText('1 notice')).toBeInTheDocument()
    expect(within(page).getByText('outputs-omitted')).toBeInTheDocument()
    expect(within(page).getByText('64:9')).toBeInTheDocument()
  })

  it('still renders a file the linter rejects', async () => {
    server.use(http.get(YAML_URL, () => HttpResponse.text('spec: 1\nname: broken\njobs: 42\n')))

    renderApp('/hello/hello/file')

    const page = screen.getByRole('main')
    expect(await within(page).findByText('name: broken')).toBeInTheDocument()
    expect(within(page).getByText('2 errors')).toBeInTheDocument()
    expect(within(page).getByText('must be object')).toBeInTheDocument()
  })

  it('renders the run snapshot handed to it instead of fetching the current file', async () => {
    server.use(http.get(YAML_URL, () => HttpResponse.text('spec: 1\nname: fetched\n')))

    renderApp({
      pathname: '/hello/hello/file',
      state: { yaml: 'spec: 1\nname: snapshot\n', runId: 'run_1' },
    })

    const page = screen.getByRole('main')
    expect(await within(page).findByText('name: snapshot')).toBeInTheDocument()
    expect(within(page).getByText(/snapshot from run run_1/)).toBeInTheDocument()
    expect(within(page).queryByText('name: fetched')).not.toBeInTheDocument()
  })
})
