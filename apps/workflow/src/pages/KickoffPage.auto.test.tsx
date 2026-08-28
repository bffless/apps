/**
 * The headless entry point (07/D12): `GET /<impl>/<workflow>/run?auto=1&inputs=
 * <base64url(JSON)>` starts the run with no Start click, and a start the page
 * refuses says so in the DOM (`kickoff-invalid`) *and* on `window.__workflow`
 * — a driver that only ever polls the global must never be left waiting on a
 * run that was never going to start.
 *
 * Interactive kickoff is unchanged and stays proven in `KickoffPage.test.tsx`;
 * the last case here is the fence that says so.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { delay, http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import App from '../App'
import { publishWorkflowGlobal } from '../lib/workflowGlobal'
import { server } from '../mocks/server'
import type { AppStore } from '../store'
import { makeStore } from '../store'
import { runClosed } from '../store/runSlice'
import { runnerControllers } from '../store/runnerMiddleware'

const YAML_URL = '/w/hello/.bffless/workflows/hello.workflow.yaml'

/** What a driver writes into the URL: base64url of the JSON, unpadded. */
function encode(values: Record<string, unknown>): string {
  return btoa(JSON.stringify(values)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const stores: AppStore[] = []

afterEach(() => {
  for (const store of stores) store.dispatch(runClosed())
  runnerControllers.abortAll()
  stores.length = 0
  publishWorkflowGlobal(null)
})

function renderApp(path: string) {
  const store = makeStore()
  stores.push(store)
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
  return { store, page: screen.getByRole('main') }
}

describe('KickoffPage — ?auto=1', () => {
  it('starts a headless run from `?inputs=`, with no Start click and no form', async () => {
    // `e30` is `{}`: every input takes its declared default, exactly as an
    // untouched form would (hello's `greeting` is `required` *and* defaulted).
    const { page, store } = renderApp('/hello/hello/run?auto=1&inputs=e30')

    expect(await within(page).findByTestId('run-status')).toHaveAttribute('data-state', 'running')

    const run = store.getState().run.state
    expect(run?.headless).toBe(true)
    expect(run?.impl).toBe('hello')
    expect(run?.workflow).toBe('hello')
    expect(run?.inputs).toEqual({ greeting: 'Hello', names: ['world'], photo: null, shout: false })

    expect(within(page).queryByTestId('kickoff-form')).not.toBeInTheDocument()
    expect(within(page).queryByTestId('kickoff-invalid')).not.toBeInTheDocument()
  })

  it('takes the supplied values over the declared defaults', async () => {
    const { page, store } = renderApp(
      `/hello/hello/run?auto=1&inputs=${encode({ greeting: 'Hi', shout: true })}`,
    )

    await within(page).findByTestId('run-status')
    expect(store.getState().run.state?.inputs).toEqual({
      greeting: 'Hi',
      names: ['world'],
      photo: null,
      shout: true,
    })
  })

  it('publishes the live run on `window.__workflow` once it is running', async () => {
    const { page } = renderApp('/hello/hello/run?auto=1&inputs=e30')

    await within(page).findByTestId('run-status')
    await waitFor(() => expect(window.__workflow?.status).toBe('running'))
    expect(window.__workflow?.runId).toMatch(/^run_/)
  })

  it('refuses to start on inputs that do not validate, and says so both ways', async () => {
    const { page, store } = renderApp(
      `/hello/hello/run?auto=1&inputs=${encode({ greeting: 42, names: ['nope'] })}`,
    )

    const invalid = await within(page).findByTestId('kickoff-invalid')
    expect(within(invalid).getByText('Expected a valid string value')).toBeInTheDocument()

    // Nothing started, and the page stayed put.
    expect(store.getState().run.state).toBeNull()
    expect(within(page).queryByTestId('run-status')).not.toBeInTheDocument()
    expect(within(page).queryByTestId('kickoff-form')).not.toBeInTheDocument()

    expect(window.__workflow?.status).toBe('invalid')
    expect(window.__workflow?.runId).toBe('')
    expect(window.__workflow?.currentSteps).toEqual([])
    expect(Object.keys(window.__workflow?.errors ?? {}).sort()).toEqual(['greeting', 'names'])
  })

  it('reports an `inputs` parameter it cannot decode as invalid, rather than throwing', async () => {
    const { page, store } = renderApp('/hello/hello/run?auto=1&inputs=not%20base64!!')

    await within(page).findByTestId('kickoff-invalid')
    expect(store.getState().run.state).toBeNull()
    expect(window.__workflow?.status).toBe('invalid')
    expect(Object.keys(window.__workflow?.errors ?? {})).toEqual(['inputs'])
  })

  it('reports a missing `inputs` parameter as invalid — a driver bug, not "no inputs"', async () => {
    const { page } = renderApp('/hello/hello/run?auto=1')

    await within(page).findByTestId('kickoff-invalid')
    expect(window.__workflow?.status).toBe('invalid')
  })

  it('shows `kickoff-auto` instead of the form while the run is being started', async () => {
    server.use(
      http.get(YAML_URL, async () => {
        await delay('infinite')
        return HttpResponse.text('')
      }),
    )
    const { page } = renderApp('/hello/hello/run?auto=1&inputs=e30')

    expect(await within(page).findByTestId('kickoff-auto')).toBeInTheDocument()
    expect(within(page).queryByTestId('kickoff-form')).not.toBeInTheDocument()
  })

  it('reports a workflow that does not validate as invalid too, so the driver never hangs', async () => {
    server.use(http.get(YAML_URL, () => HttpResponse.text('spec: 1\nname: broken\njobs: 42\n')))

    const { page, store } = renderApp('/hello/hello/run?auto=1&inputs=e30')

    expect(
      await within(page).findByText('This workflow does not validate, so it cannot be run'),
    ).toBeInTheDocument()
    expect(store.getState().run.state).toBeNull()
    await waitFor(() => expect(window.__workflow?.status).toBe('invalid'))
  })

  it('leaves an ordinary kickoff alone: no `auto`, no global, and the form as before', async () => {
    const { page } = renderApp('/hello/hello/run')

    expect(await within(page).findByTestId('kickoff-form')).toBeInTheDocument()
    expect(within(page).queryByTestId('kickoff-auto')).not.toBeInTheDocument()
    expect(within(page).queryByTestId('kickoff-invalid')).not.toBeInTheDocument()
    expect(window.__workflow).toBeUndefined()
  })
})
