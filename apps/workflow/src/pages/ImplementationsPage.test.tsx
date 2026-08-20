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
import { describe, expect, it } from 'vitest'
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
  it('lists every implementation discovery found', async () => {
    renderApp()

    const list = await screen.findByTestId('implementations')
    expect(within(list).getByText('hello')).toBeInTheDocument()
    expect(within(list).getByText('1 workflow')).toBeInTheDocument()
  })

  it('explains how to publish one when there are none', async () => {
    server.use(http.get('/api/aliases', () => HttpResponse.json([])))

    renderApp()

    expect(await screen.findByText('No implementations found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /publish/i })).toHaveAttribute(
      'href',
      expect.stringContaining('06-discovery-publishing-files.md'),
    )
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
