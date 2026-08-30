/**
 * The trust boundary on the read-only run page (apps#364): the run row's
 * `impl` — a field any authenticated member can write — picks both the
 * `/w/<impl>/` bundle a viewer's islands load and the `/api/<impl>/`
 * namespace the host proxies their tool calls into, under the viewer's own
 * session. So the page only honours it once discovery vouches for it as a
 * real, non-preview alias; otherwise every island is withheld — the value
 * falls back to its ordinary viewer plus a one-line note, and no frame
 * mounts.
 *
 * The fixture is the rendered run (all five named renderers, island
 * included), reseeded with a planted `impl` where the test needs one.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import { db, nextId, seedRenderedRun, stepRowKey } from '../mocks/db'
import { RENDERED_RUN, RENDERED_RUN_ID } from '../mocks/fixtures/renderedRun'
import { HELLO_INDEX } from '../mocks/handlers'
import { server } from '../mocks/server'
import { makeStore } from '../store'
import { workflowApi } from '../store/workflowApi'

// jsdom has no canvas (`ChartView.test.tsx` explains why); the rendered run
// declares a chart, and this test only cares that the *island* is withheld.
vi.mock('uplot', async () => (await import('../test/uplotMock')).inertUPlot())

const WITHHELD_NOTE = 'island withheld: unknown implementation'

/** The rendered run's rows, with the row's own `impl` claim replaced. */
function seedPlantedRun(impl: string) {
  db.runs.set(RENDERED_RUN_ID, { ...RENDERED_RUN.run, impl, _id: nextId() })
  for (const step of RENDERED_RUN.steps) {
    db.steps.set(stepRowKey(step.runId, step.key), { ...step, _id: nextId() })
  }
}

function renderRun() {
  const store = makeStore()
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/hello/rendered/runs/${RENDERED_RUN_ID}`]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
  return store
}

/** Discovery has answered — the page is no longer merely "in flight". */
async function discoverySettled(store: ReturnType<typeof makeStore>) {
  await waitFor(() => {
    expect(workflowApi.endpoints.discover.select()(store.getState()).isSuccess).toBe(true)
  })
  return workflowApi.endpoints.discover.select()(store.getState()).data
}

describe('RunPage — run.impl trust boundary (read-only path)', () => {
  it('withholds the island when the row names an alias discovery does not list', async () => {
    seedPlantedRun('evil')

    const store = renderRun()
    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')

    // Not a race: still withheld once discovery has actually answered.
    const list = await discoverySettled(store)
    expect(list?.some((candidate) => candidate.alias === 'evil')).toBe(false)

    expect(within(page).queryByTestId('island-frame')).toBeNull()
    expect(within(page).getAllByText(WITHHELD_NOTE).length).toBeGreaterThan(0)
    // The rest of the record still renders — degrade, don't blank the page.
    expect(within(page).getAllByTestId('renderer').length).toBeGreaterThan(0)
  })

  it('withholds the island when the row names a preview alias, even a discovered one', async () => {
    // A published PR preview: discovery lists it (preview: true), and it is
    // still never a legitimate target for a finished run's islands.
    server.use(
      http.get('/api/workflow/aliases', () =>
        HttpResponse.json([
          { name: 'workflow', isAutoPreview: false, repository: 'bffless/workflow' },
          { name: 'hello', isAutoPreview: false, repository: 'bffless/workflow' },
          { name: 'hello-pr-2', isAutoPreview: true, repository: 'bffless/workflow' },
        ]),
      ),
      http.get('/w/hello-pr-2/.bffless/workflows/index.json', () => HttpResponse.json(HELLO_INDEX)),
    )
    seedPlantedRun('hello-pr-2')

    const store = renderRun()
    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')

    // Prove this is the preview exclusion, not the unknown-alias branch.
    const list = await discoverySettled(store)
    expect(list?.some((candidate) => candidate.alias === 'hello-pr-2' && candidate.preview)).toBe(true)

    expect(within(page).queryByTestId('island-frame')).toBeNull()
    expect(within(page).getAllByText(WITHHELD_NOTE).length).toBeGreaterThan(0)
  })

  it('mounts the island once discovery confirms the row names a real alias', async () => {
    server.use(
      http.get('/w/hello/islands/line-viewer.html', () =>
        HttpResponse.text('<!doctype html><p>viewer</p>'),
      ),
    )
    seedRenderedRun() // the unmodified row: impl 'hello', a discovered non-preview alias

    renderRun()
    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')

    expect(await within(page).findByTestId('island-frame')).toBeInTheDocument()
    expect(within(page).queryByText(WITHHELD_NOTE)).toBeNull()
  })
})
