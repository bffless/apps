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

  it('welcomes a fresh install with the runtime project in the publish path', async () => {
    server.use(http.get('/api/workflow/aliases', () => HttpResponse.json([])))

    renderApp()

    const empty = await screen.findByTestId('implementations-empty')
    expect(within(empty).getByText('Welcome to Workflow')).toBeInTheDocument()
    // The runtime project (the mocked /api/workflow/project answer) personalizes
    // the publish line and prefills the snippet's `repository:` input.
    expect(await within(empty).findByTestId('publish-target')).toHaveTextContent(
      'bffless/workflow',
    )
    expect(within(empty).getByTestId('publish-snippet')).toHaveTextContent(
      'repository: bffless/workflow',
    )
    expect(within(empty).getByTestId('publish-snippet')).toHaveTextContent(
      'uses: bffless/publish-workflow@v1',
    )
  })

  it('keeps the publish path generic when no project resolves', async () => {
    server.use(
      http.get('/api/workflow/aliases', () => HttpResponse.json([])),
      http.get('/api/workflow/project', () => HttpResponse.json({ repository: null })),
    )

    renderApp()

    const empty = await screen.findByTestId('implementations-empty')
    // The fallback line names no project…
    expect(await within(empty).findByTestId('publish-target')).toHaveTextContent(
      /this harness[’']s project/,
    )
    // …the snippet carries a placeholder instead of a wrong guess…
    expect(within(empty).getByTestId('publish-snippet')).toHaveTextContent(
      'repository: <owner>/<repo>',
    )
    // …and there is no scoped-discovery role hint, because discovery was unscoped.
    expect(within(empty).queryByTestId('scope-hint')).not.toBeInTheDocument()
  })

  it('links the hello reference, the writing guide and the implementations repo', async () => {
    server.use(http.get('/api/workflow/aliases', () => HttpResponse.json([])))

    renderApp()

    const empty = await screen.findByTestId('implementations-empty')
    expect(await within(empty).findByRole('link', { name: 'hello' })).toHaveAttribute(
      'href',
      'https://github.com/bffless/workflow-implementations/tree/main/workflows/hello',
    )
    expect(
      within(empty).getByRole('link', { name: 'Writing an implementation' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/bffless/apps/blob/main/apps/workflow/docs/writing-an-implementation.md',
    )
    expect(
      within(empty).getByRole('link', { name: 'bffless/workflow-implementations' }),
    ).toHaveAttribute('href', 'https://github.com/bffless/workflow-implementations')
  })

  it('offers a copy of the publish snippet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    server.use(http.get('/api/workflow/aliases', () => HttpResponse.json([])))

    try {
      renderApp()

      const empty = await screen.findByTestId('implementations-empty')
      await within(empty).findByTestId('publish-target')
      fireEvent.click(within(empty).getByRole('button', { name: 'Copy workflow' }))
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('repository: bffless/workflow'))
      expect(await within(empty).findByText('copied')).toBeInTheDocument()
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    }
  })

  it('names the project and the missing-role cause when a scoped build finds nothing', async () => {
    vi.stubEnv('VITE_BFFLESS_PROJECT', 'bffless/workflow')
    server.use(http.get('/api/workflow/aliases', () => HttpResponse.json([])))

    renderApp()

    const hint = await screen.findByTestId('scope-hint')
    expect(hint).toHaveTextContent('bffless/workflow')
    expect(hint).toHaveTextContent(/no role on that project/)
  })


  it('says discovery failed rather than "you published nothing"', async () => {
    server.use(http.get('/api/workflow/aliases', () => HttpResponse.json({ error: 'boom' }, { status: 500 })))

    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText("Couldn't reach the server")).toBeInTheDocument()
    expect(within(page).getByText(/answered 500/)).toBeInTheDocument()
    expect(within(page).queryByTestId('implementations-empty')).not.toBeInTheDocument()
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
