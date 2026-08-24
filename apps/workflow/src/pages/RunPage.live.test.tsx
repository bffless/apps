/**
 * The live run page (Task 18, 08): rendered straight off the run slice while
 * this tab is the one driving it — proven at `hello`'s own `confirm/0/review`
 * waiting point (Task 17's scenario-2 harness, lifted into
 * `src/test/helloHarness.ts`).
 *
 * `GET /api/workflow/run` is stubbed for the whole suite to answer "nothing
 * here" and to count its own calls — the exact shape of the race the live
 * path exists to survive (Task 17's write-ahead persistence means the row a
 * `GET` issued right after `run.started` navigates here would read may not
 * have landed yet). If the live path ever regresses into depending on that
 * read, every test below fails on "No such run", a stuck "Loading…", or a
 * non-zero call count — never a false pass.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../App'
import { server } from '../mocks/server'
import type { AppStore } from '../store'
import { REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting } from '../test/helloHarness'

let getRunCalls = 0

beforeEach(() => {
  getRunCalls = 0
  server.use(
    http.get('/api/workflow/run', () => {
      getRunCalls++
      return HttpResponse.json({ run: null, steps: [] })
    }),
  )
})

afterEach(() => {
  resetHelloHarness()
})

function renderLive(store: AppStore, runId: string) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/hello/hello/runs/${runId}`]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

function chip(page: HTMLElement, key: string): HTMLElement | null {
  return (
    within(page)
      .getAllByTestId('step')
      .find((el) => el.getAttribute('data-key') === key) ?? null
  )
}

describe('RunPage — live', () => {
  it('renders off the slice with no server read, auto-selects the waiting form, and finishes the run on submit', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    renderLive(store, runId)

    const page = screen.getByRole('main')

    // The race this page exists to survive: never "no such run", never stuck
    // loading, and — the strongest form of the claim — the server read this
    // page used to depend on never happens at all.
    expect(within(page).queryByText('No such run')).not.toBeInTheDocument()
    expect(within(page).queryByText('Loading…')).not.toBeInTheDocument()
    expect(getRunCalls).toBe(0)

    expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'running')

    // A waiting form step is auto-selected — first by topo order — with no
    // click on its chip.
    expect(chip(page, REVIEW_KEY)).toHaveAttribute('data-state', 'waiting')
    expect(within(page).getByLabelText(/^approved/)).toBeChecked()
    const submit = within(page).getByRole('button', { name: 'Finish' })
    expect(submit).toBeInTheDocument()

    fireEvent.click(submit)

    await waitFor(() => {
      expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')
    })
    expect(chip(page, REVIEW_KEY)).toHaveAttribute('data-state', 'succeeded')
    expect(getRunCalls).toBe(0)
  })
})
