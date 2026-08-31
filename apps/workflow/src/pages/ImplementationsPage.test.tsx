/**
 * The harness's front door (08): what discovery found, and the one click that
 * gets from an implementation to its workflows. Mounted as the whole `<App/>`
 * so the route table and the Shell are under test too, and answered by the MSW
 * backend rather than by a stubbed hook — a card here is a real `index.json`.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { seedFinishedRun } from '../mocks/db'
import { server } from '../mocks/server'
import { makeStore } from '../store'

/** A fresh store per case, so no RTK Query cache survives into the next one. */
function renderApp(path = '/') {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('ImplementationsPage', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('lists every implementation discovery found', async () => {
    renderApp()

    const list = await screen.findByTestId('implementations')
    expect(within(list).getByText('hello')).toBeInTheDocument()
    expect(within(list).getByText('2 workflows')).toBeInTheDocument()
  })

  it('shows how the last run of each published workflow went', async () => {
    seedFinishedRun()
    renderApp()

    const list = await screen.findByTestId('implementations')
    expect(within(list).getByText('Hello workflow')).toBeInTheDocument()
    expect(await within(list).findByText('Succeeded')).toHaveAttribute('data-state', 'succeeded')
  })

  it('explains how to publish one when there are none', async () => {
    server.use(http.get('/api/workflow/aliases', () => HttpResponse.json([])))

    renderApp()

    expect(await screen.findByText('No implementations found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /publish/i })).toHaveAttribute(
      'href',
      expect.stringContaining('writing-an-implementation.md'),
    )
  })

  it('names the project and the missing-role cause when a scoped build finds nothing', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', 'bffless/workflow')
    server.use(http.get('/api/workflow/aliases', () => HttpResponse.json([])))

    renderApp()

    const hint = await screen.findByTestId('scope-hint')
    expect(hint).toHaveTextContent('bffless/workflow')
    expect(hint).toHaveTextContent(/no role on that project/)
  })

  it('offers no project hint when the build is unscoped', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', undefined)
    server.use(http.get('/api/workflow/aliases', () => HttpResponse.json([])))

    renderApp()

    expect(await screen.findByText('No implementations found')).toBeInTheDocument()
    expect(screen.queryByTestId('scope-hint')).not.toBeInTheDocument()
  })

  it('says discovery failed rather than "you published nothing"', async () => {
    server.use(http.get('/api/workflow/aliases', () => HttpResponse.json({ error: 'boom' }, { status: 500 })))

    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText("Couldn't reach the server")).toBeInTheDocument()
    expect(within(page).getByText(/answered 500/)).toBeInTheDocument()
    expect(within(page).queryByText('No implementations found')).not.toBeInTheDocument()
  })

  it('opens an implementation on its workflows', async () => {
    seedFinishedRun()
    renderApp()

    fireEvent.click(await screen.findByText('hello'))

    const workflows = await screen.findByTestId('workflow-list')
    expect(within(workflows).getByText('Hello workflow')).toBeInTheDocument()
    expect(await within(workflows).findByText('Succeeded')).toHaveAttribute(
      'data-state',
      'succeeded',
    )
  })
})
