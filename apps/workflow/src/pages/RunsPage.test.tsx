/**
 * Past runs (08): the table, its client-side status filter (Decision 6), and
 * the two ways out of a row — the run itself, and a re-run pre-filled from it.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import App from '../App'
import { readScope, writeScope } from '../lib/scope'
import {
  db,
  MOCK_ADMIN,
  MOCK_MEMBER,
  MOCK_OTHER,
  nextId,
  seedFinishedRun,
  seedWaitingRun,
  setMockUser,
  stepRowKey,
} from '../mocks/db'
import { FINISHED_RUN, FIXTURE_RUN_ID } from '../mocks/fixtures/finishedRun'
import { WAITING_RUN_ID, WAITING_STEP_KEY } from '../mocks/fixtures/waitingRun'
import { server } from '../mocks/server'
import { makeStore } from '../store'

function renderApp(path = '/hello/hello/runs') {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

const fixtureRow = () => new RegExp(FIXTURE_RUN_ID)

describe('RunsPage', () => {
  it('lists a past run with its status, duration and outputs', async () => {
    seedFinishedRun()
    renderApp()

    const page = screen.getByRole('main')
    const row = await within(page).findByRole('row', { name: fixtureRow() })

    expect(within(row).getByText('Succeeded')).toHaveAttribute('data-state', 'succeeded')
    // Decision 12: fixtures are owned by the mock's default member. The column
    // means something now that a list can hold more than one person's runs
    // (spec 11 §What the person sees), so it renders the person — the
    // denormalised `startedByEmail` — and not the raw uuid beside it.
    expect(within(row).getByText(MOCK_MEMBER.email)).toBeInTheDocument()
    expect(within(row).queryByText(MOCK_MEMBER.id)).not.toBeInTheDocument()
    expect(within(row).getByText('12.5 s')).toBeInTheDocument()
    expect(within(row).getByText(/poster\.png/)).toBeInTheDocument()

    expect(within(row).getByRole('link', { name: FIXTURE_RUN_ID })).toHaveAttribute(
      'href',
      `/hello/hello/runs/${FIXTURE_RUN_ID}`,
    )
    expect(within(row).getByRole('link', { name: 'Re-run' })).toHaveAttribute(
      'href',
      `/hello/hello/run?from=${FIXTURE_RUN_ID}`,
    )
  })

  it('filters the table by status', async () => {
    seedFinishedRun()
    renderApp()

    const page = screen.getByRole('main')
    await within(page).findByRole('row', { name: fixtureRow() })

    fireEvent.change(within(page).getByLabelText('Status'), { target: { value: 'failed' } })

    expect(within(page).queryByRole('row', { name: fixtureRow() })).not.toBeInTheDocument()
    expect(within(page).getByText('No runs with that status')).toBeInTheDocument()
  })

  it('tells a failed read apart from a workflow that has never run', async () => {
    seedFinishedRun()
    server.use(
      http.get('/api/workflow/runs', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )

    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText("Couldn't load runs")).toBeInTheDocument()
    expect(within(page).queryByText('No runs yet')).not.toBeInTheDocument()
    expect(within(page).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('says so when the workflow has never run', async () => {
    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText('No runs yet')).toBeInTheDocument()
  })

  /**
   * "Waiting on <step>" (apps#473): a running run parked on a form says so in
   * its Status cell, and the step's name links to that step on the run page.
   * The keys come from the list endpoint's join; the name from the row's own
   * definition — the label the run page gives the step (its id, `review`,
   * since the hello form declares no `name`).
   */
  describe('the waiting-on note', () => {
    it('names the step a running run is waiting on, linked to it on the run page', async () => {
      seedWaitingRun()
      renderApp()

      const page = screen.getByRole('main')
      const row = await within(page).findByRole('row', { name: new RegExp(WAITING_RUN_ID) })
      const cell = within(row).getByText('Running').closest('td') as HTMLElement

      expect(within(cell).getByText('Running')).toHaveAttribute('data-state', 'running')
      const note = within(cell).getByTestId('run-waiting')
      expect(note).toHaveTextContent(/^waiting on review$/)
      expect(within(note).getByRole('link', { name: 'review' })).toHaveAttribute(
        'href',
        `/hello/hello/runs/${WAITING_RUN_ID}/job/confirm/0?step=confirm%2F0%2Freview`,
      )
    })

    it('names the first waiting step in scheduling order and counts the rest', async () => {
      seedWaitingRun()
      // A second parked step, earlier in the schedule than the form: the note
      // leads with it and counts the form.
      const key = 'flaky/0/after'
      const after = db.steps.get(stepRowKey(WAITING_RUN_ID, key))!
      db.steps.set(stepRowKey(WAITING_RUN_ID, key), { ...after, status: 'waiting', finishedAt: null })
      renderApp()

      const page = screen.getByRole('main')
      const row = await within(page).findByRole('row', { name: new RegExp(WAITING_RUN_ID) })
      const note = within(row).getByTestId('run-waiting')

      expect(note).toHaveTextContent(/^waiting on after \+1$/)
      expect(within(note).getByRole('link', { name: 'after' })).toHaveAttribute(
        'href',
        `/hello/hello/runs/${WAITING_RUN_ID}/job/flaky/0?step=flaky%2F0%2Fafter`,
      )
      expect(note.querySelector('.run-waiting-more')).toHaveAttribute('title', 'review')
    })

    it('says nothing for a finished run, whatever its rows were left in', async () => {
      seedFinishedRun()
      renderApp()

      const page = screen.getByRole('main')
      const row = await within(page).findByRole('row', { name: fixtureRow() })

      expect(within(row).queryByTestId('run-waiting')).not.toBeInTheDocument()
    })

    it('says nothing for a running run that waits on nothing', async () => {
      seedWaitingRun()
      db.steps.delete(stepRowKey(WAITING_RUN_ID, WAITING_STEP_KEY))
      renderApp()

      const page = screen.getByRole('main')
      const row = await within(page).findByRole('row', { name: new RegExp(WAITING_RUN_ID) })

      expect(within(row).getByText('Running')).toBeInTheDocument()
      expect(within(row).queryByTestId('run-waiting')).not.toBeInTheDocument()
    })
  })

  /**
   * The Annotations column (Task 20): the run row's own `annotationCounts`
   * rollup, written at `run.finished`. A row from before the rollup existed
   * carries no such column — and an empty cell is the honest answer there, not
   * three zeroes it would be inventing.
   */
  describe('the Annotations column', () => {
    it('shows the rolled-up counts of a run', async () => {
      seedFinishedRun()
      renderApp()

      const page = screen.getByRole('main')
      const row = await within(page).findByRole('row', { name: fixtureRow() })
      const cell = within(row).getByTestId('run-annotations')

      expect([...cell.querySelectorAll('.badge')].map((el) => el.textContent)).toEqual([
        '0',
        '1',
        '1',
      ])
      expect(cell.querySelector('.badge-warning')).toHaveTextContent('1')
      expect(cell.querySelector('.badge-notice')).toHaveTextContent('1')
      expect(cell.querySelector('.badge-error')).toHaveTextContent('0')
    })

    it('leaves the cell empty for a row written before the rollup existed', async () => {
      const pre = { ...FINISHED_RUN.run, runId: 'run_prem2', _id: nextId() }
      delete pre.annotationCounts
      db.runs.set('run_prem2', pre)
      renderApp()

      const page = screen.getByRole('main')
      const row = await within(page).findByRole('row', { name: /run_prem2/ })

      expect(within(row).queryByTestId('run-annotations')).not.toBeInTheDocument()
      expect(within(row).getAllByText('—').length).toBeGreaterThan(0)
    })
  })

  /**
   * Whose runs the list shows (spec 11 §What the person sees, D27). The list
   * is the caller's own by default — for everyone, the project owner
   * included. An owner/admin gets a toggle that *asks* for the rest, on the
   * query string and in the header, and nobody else even sees it; a member who
   * hand-sets the ask gets the endpoint's 403 rather than a quietly narrowed
   * list.
   */
  describe('whose runs the list shows (spec 11 D27)', () => {
    const OTHER_RUN_ID = 'run_theirs'

    /** The same workflow, a run of it started by the third identity (`MOCK_OTHER`). */
    function seedSomeoneElsesRun(): void {
      db.runs.set(OTHER_RUN_ID, {
        ...FINISHED_RUN.run,
        runId: OTHER_RUN_ID,
        startedBy: MOCK_OTHER.id,
        startedByEmail: MOCK_OTHER.email,
        _id: nextId(),
      })
    }

    /** Every `runs` list request, as the server saw it — the ask is a property of the request (D27). */
    function watchListRequests(): { calls: { scope: string | null; header: string | null }[]; stop: () => void } {
      const calls: { scope: string | null; header: string | null }[] = []
      const onRequestStart = ({ request }: { request: Request }) => {
        const url = new URL(request.url)
        if (request.method === 'GET' && url.pathname === '/api/workflow/runs') {
          calls.push({ scope: url.searchParams.get('scope'), header: request.headers.get('x-workflow-scope') })
        }
      }
      server.events.on('request:start', onRequestStart)
      return { calls, stop: () => server.events.removeListener('request:start', onRequestStart) }
    }

    afterEach(() => {
      writeScope('mine')
    })

    it("shows the caller's own runs and offers a member no way to widen them", async () => {
      seedFinishedRun()
      seedSomeoneElsesRun()
      renderApp()

      const page = screen.getByRole('main')
      await within(page).findByRole('row', { name: fixtureRow() })

      expect(within(page).queryByRole('row', { name: new RegExp(OTHER_RUN_ID) })).not.toBeInTheDocument()
      expect(within(page).queryByLabelText('All runs')).not.toBeInTheDocument()
    })

    it('offers an owner the toggle, off, and asks for everyone’s runs only once it is on', async () => {
      seedFinishedRun()
      seedSomeoneElsesRun()
      setMockUser(MOCK_ADMIN)
      const watch = watchListRequests()

      try {
        renderApp()

        const page = screen.getByRole('main')
        // The owner started none of these runs, so "yours" is empty — and the
        // toggle is still there, because it is the answer to "why is this
        // empty".
        expect(await within(page).findByText('No runs yet')).toBeInTheDocument()
        const toggle = within(page).getByLabelText('All runs')
        expect(toggle).not.toBeChecked()
        // Nothing widened before the ask — however many times the list asked.
        expect(watch.calls.length).toBeGreaterThan(0)
        expect(watch.calls.filter((call) => call.scope !== null || call.header !== null)).toEqual([])

        fireEvent.click(toggle)

        expect(await within(page).findByRole('row', { name: fixtureRow() })).toBeInTheDocument()
        expect(within(page).getByRole('row', { name: new RegExp(OTHER_RUN_ID) })).toBeInTheDocument()
        // Both ways of asking ride together: the query string the list rule
        // reads, and the header every other run-scoped call has to carry.
        expect(watch.calls.at(-1)).toEqual({ scope: 'all', header: 'all' })
        expect(within(page).getByLabelText('All runs')).toBeChecked()
        // The column is what makes the widened list readable at all.
        expect(within(page).getByText(MOCK_OTHER.email)).toBeInTheDocument()
      } finally {
        watch.stop()
      }
    })

    it('narrows back to the caller’s own runs when the toggle goes off again', async () => {
      seedFinishedRun()
      seedSomeoneElsesRun()
      setMockUser(MOCK_ADMIN)
      renderApp()

      const page = screen.getByRole('main')
      fireEvent.click(await within(page).findByLabelText('All runs'))
      await within(page).findByRole('row', { name: new RegExp(OTHER_RUN_ID) })

      fireEvent.click(within(page).getByLabelText('All runs'))

      await waitFor(() =>
        expect(within(page).queryByRole('row', { name: new RegExp(OTHER_RUN_ID) })).not.toBeInTheDocument(),
      )
      expect(within(page).getByLabelText('All runs')).not.toBeChecked()
    })

    /**
     * A stale ask (fix round 1). The ask outlives the session that made it —
     * a shared machine, a role taken away, an admin who signed out — and the
     * person holding it has no toggle to turn it off with, so the page has to
     * put itself right: every list request would 403, and Retry would repeat
     * the same 403 for ever.
     */
    it('narrows a stale all-scope ask when the viewer does not hold the role, with no error to clear', async () => {
      seedFinishedRun()
      seedSomeoneElsesRun()
      // Remembered by this browser from an identity that could ask; this one
      // cannot, and has no toggle to discover that with.
      writeScope('all')
      renderApp()

      const page = screen.getByRole('main')
      // Their own runs, straight away — not a refusal they cannot act on.
      expect(await within(page).findByRole('row', { name: fixtureRow() })).toBeInTheDocument()
      expect(within(page).queryByText("Couldn't load runs")).not.toBeInTheDocument()
      expect(within(page).queryByRole('row', { name: new RegExp(OTHER_RUN_ID) })).not.toBeInTheDocument()
      expect(within(page).queryByLabelText('All runs')).not.toBeInTheDocument()
      // And the ask is gone from storage, so the header stops riding every
      // other call this browser makes too.
      expect(readScope()).toBe('mine')
    })

    it('leaves an owner’s remembered ask alone — it is theirs to hold', async () => {
      seedFinishedRun()
      seedSomeoneElsesRun()
      setMockUser(MOCK_ADMIN)
      writeScope('all')
      renderApp()

      const page = screen.getByRole('main')
      expect(await within(page).findByRole('row', { name: new RegExp(OTHER_RUN_ID) })).toBeInTheDocument()
      expect(within(page).getByRole('row', { name: fixtureRow() })).toBeInTheDocument()
      expect(within(page).getByLabelText('All runs')).toBeChecked()
      expect(readScope()).toBe('all')
    })

    // The belt to that brace: a role taken away between one page load and the
    // next is not in `whoami`'s cached answer yet, so the refusal itself is
    // what the page narrows on.
    it('narrows on the endpoint’s own 403, whatever whoami still believes', async () => {
      seedFinishedRun()
      setMockUser(MOCK_ADMIN)
      writeScope('all')
      server.use(
        http.get('/api/workflow/runs', ({ request }) => {
          const url = new URL(request.url)
          const asked =
            url.searchParams.get('scope') === 'all' || request.headers.get('x-workflow-scope') === 'all'
          return asked
            ? HttpResponse.json({ ok: false, code: 'SCOPE_FORBIDDEN' }, { status: 403 })
            : HttpResponse.json({ records: [] })
        }),
      )

      renderApp()

      const page = screen.getByRole('main')
      expect(await within(page).findByText('No runs yet')).toBeInTheDocument()
      expect(within(page).queryByText("Couldn't load runs")).not.toBeInTheDocument()
      // Still an owner, so the toggle is still theirs — just not on any more.
      expect(within(page).getByLabelText('All runs')).not.toBeChecked()
      expect(readScope()).toBe('mine')
    })
  })
})
