/**
 * The read-only run page (08): a finished run rebuilt from its rows by the
 * replay engine, and every section of the page read back off the rendered DOM
 * rather than off the state that produced it.
 *
 * The fixture run has **6** step rows (R2) but the graph draws one chip per
 * *declared* step — a matrix job is one card whose chips show the item its
 * selector names (Task 14), so `greet/1/say` is the sixth row and is reached by
 * changing that selector, not by a sixth chip.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { MOCK_ADMIN, db, nextId, seedFinishedRun, setMockUser, stepRowKey } from '../mocks/db'
import { FINISHED_RUN, FIXTURE_RUN_ID } from '../mocks/fixtures/finishedRun'
import { server } from '../mocks/server'
import { makeStore } from '../store'
import { fileUrl } from '../lib/coerce'

const RUN_PATH = `/hello/hello/runs/${FIXTURE_RUN_ID}`

function renderApp(path = RUN_PATH) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

const chip = (key: string) => document.querySelector(`[data-key="${key}"]`) as HTMLElement | null

/** The seeded run, rendered and settled. */
async function openRun() {
  seedFinishedRun()
  renderApp()
  const page = screen.getByRole('main')
  await within(page).findByTestId('run-status')
  return page
}

/** Select a step and switch its pane to one tab. */
function openTab(page: HTMLElement, key: string, tab: string): HTMLElement {
  fireEvent.click(chip(key)!)
  fireEvent.click(within(page).getByRole('tab', { name: tab }))
  return within(page).getByTestId('step-pane')
}

describe('RunPage', () => {
  it('shows the run header, its status and a chip per declared step', async () => {
    const page = await openRun()

    expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')
    // Scoped to the header: the run card under the graph names the workflow
    // and the run too.
    const head = page.querySelector('.run-head') as HTMLElement
    expect(within(head).getByText('Hello workflow')).toBeInTheDocument()
    expect(within(head).getByText(FIXTURE_RUN_ID)).toBeInTheDocument()
    expect(within(head).getByText('user_fixture')).toBeInTheDocument()
    expect(within(page).getByText('12.5 s')).toBeInTheDocument()

    expect(within(page).getAllByTestId('step')).toHaveLength(5)
    expect(chip('greet/1/say')).toBeNull()
    fireEvent.change(within(page).getByLabelText('Matrix item of greet'), {
      target: { value: '1' },
    })
    expect(chip('greet/1/say')).toBeTruthy()
  })

  it("links to the run's own snapshot of the workflow file, and to a re-run", async () => {
    const page = await openRun()

    expect(within(page).getByRole('link', { name: 'View workflow file' })).toHaveAttribute(
      'href',
      '/hello/hello/file',
    )
    expect(within(page).getByRole('link', { name: 'Re-run' })).toHaveAttribute(
      'href',
      `/hello/hello/run?from=${FIXTURE_RUN_ID}`,
    )
    // Phase 3 owns the write actions.
    expect(within(page).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(within(page).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
  })

  it("labels a step input with where its value came from", async () => {
    const page = await openRun()

    fireEvent.click(chip('greet/0/say')!)
    const pane = within(page).getByTestId('step-pane')

    expect(within(pane).getByText('echo')).toBeInTheDocument()
    expect(within(pane).getByText(/from inputs\.greeting/)).toBeInTheDocument()
  })

  it("renders a step's declared outputs with their own renderers", async () => {
    const page = await openRun()
    const pane = openTab(page, 'slow/0/start', 'Output')

    expect(within(pane).getByRole('heading', { name: 'Hello report' })).toBeInTheDocument()
    expect(within(pane).getByText('Hello, world!')).toBeInTheDocument()

    expect(within(pane).getByAltText('poster.png')).toBeInTheDocument()
    expect(within(pane).getByRole('link', { name: 'Download' }).getAttribute('href')).toContain(
      'download=1',
    )
  })

  it("shows a form step's evaluated `with` on Input — title, fields with resolved defaults, submit", async () => {
    const page = await openRun()
    const pane = openTab(page, 'confirm/0/review', 'Input')

    expect(within(pane).getByText('title')).toBeInTheDocument()
    expect(within(pane).getByText('Does the report look right?')).toBeInTheDocument()
    expect(within(pane).getByText('fields')).toBeInTheDocument()
    // `default: ${{ needs.slow.outputs.report }}` was evaluated before the form was shown.
    expect(within(pane).getByText(/Hello, world!/)).toBeInTheDocument()
    expect(within(pane).getByText('submit')).toBeInTheDocument()
  })

  it('details the attempt, the pipeline path and the annotations of a step on Output', async () => {
    const page = await openRun()
    const pane = openTab(page, 'slow/0/start', 'Output')

    expect(within(pane).getByText('Attempt 2')).toBeInTheDocument()
    expect(within(pane).getByText('slow')).toBeInTheDocument()
    expect(within(pane).getByText('Job job_hello_1 took 1234 ms')).toBeInTheDocument()
    // The BUSY error of the attempt it retried is still on the row.
    expect(within(pane).getByText(/BUSY/)).toBeInTheDocument()
  })

  it("lists the run's own outputs, and only those, on the run card's Output", async () => {
    const page = await openRun()

    // No step selected: the run card is what sits under the graph, open on Output.
    expect(within(page).getByTestId('run-pane')).toBeInTheDocument()
    expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()

    const outputs = within(page).getByTestId('run-outputs')
    const names = [...outputs.querySelectorAll('[data-output]')].map((el) =>
      el.getAttribute('data-output'),
    )
    expect(names).toEqual(['report', 'poster', 'lines'])
  })

  it("shows the kickoff inputs on the run card's Input", async () => {
    const page = await openRun()
    fireEvent.click(within(page).getByRole('tab', { name: 'Input' }))

    const pane = within(page).getByTestId('run-pane')
    expect(within(pane).getByText('greeting')).toBeInTheDocument()
    expect(within(pane).getByText('Hello')).toBeInTheDocument()
    expect(within(pane).getByText('names')).toBeInTheDocument()
    expect(within(pane).getByText('studio')).toBeInTheDocument()
  })

  // One level of the taxonomy at a time (08, 2026-08-26): run › job › step.
  // A step's pane replaces the run card; Back climbs one level, the crumb's
  // "Run" climbs to the top, Esc and the pressed chip climb one level too.
  describe('the run, job and step cards take turns', () => {
    it('replaces the run card with the step pane on a chip click; Back climbs to the job, then the run', async () => {
      const page = await openRun()

      fireEvent.click(chip('slow/0/start')!)
      expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
      expect(within(page).queryByTestId('run-pane')).not.toBeInTheDocument()
      expect(within(page).queryByTestId('run-outputs')).not.toBeInTheDocument()

      fireEvent.click(within(page).getByTestId('step-pane-back'))
      expect(within(page).getByTestId('job-pane')).toBeInTheDocument()
      expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()
      expect(chip('slow/0/start')).toHaveAttribute('aria-pressed', 'false')

      fireEvent.click(within(page).getByTestId('step-pane-back'))
      expect(within(page).getByTestId('run-pane')).toBeInTheDocument()
      expect(within(page).queryByTestId('job-pane')).not.toBeInTheDocument()
    })

    it("climbs straight to the run on the step pane's Run crumb", async () => {
      const page = await openRun()
      fireEvent.click(chip('slow/0/start')!)
      fireEvent.click(within(within(page).getByTestId('step-pane')).getByRole('button', { name: 'Run' }))
      expect(within(page).getByTestId('run-pane')).toBeInTheDocument()
    })

    it('climbs one level on Esc, and on the pressed chip clicked again', async () => {
      const page = await openRun()

      fireEvent.click(chip('slow/0/start')!)
      fireEvent.keyDown(within(page).getByTestId('step-pane'), { key: 'Escape' })
      expect(within(page).getByTestId('job-pane')).toBeInTheDocument()

      fireEvent.click(chip('slow/0/start')!)
      expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
      fireEvent.click(chip('slow/0/start')!)
      expect(within(page).getByTestId('job-pane')).toBeInTheDocument()
    })

    it("opens the job card from a group card's header strip, with the job's evaluated outputs", async () => {
      const page = await openRun()

      fireEvent.click(within(page).getByRole('button', { name: 'Job Greet each name' }))
      const pane = within(page).getByTestId('job-pane')
      // The crumb ends on the job, the title repeats it: `Run › Greet each name`.
      expect(within(pane).getByRole('heading', { name: 'Greet each name' })).toBeInTheDocument()
      expect(within(pane).getByRole('navigation', { name: /where this sits/i })).toHaveTextContent(
        /^Run›Greet each name/,
      )
      // `lines: ${{ steps.say.outputs.line }}` collects across the matrix (01).
      expect(within(pane).getByText('lines')).toBeInTheDocument()
      expect(within(pane).getByText('Hello, world!')).toBeInTheDocument()
      expect(within(pane).getByText('Hello, studio!')).toBeInTheDocument()
      // …and goes to the step that reads it.
      expect(within(pane).getByText(/goes to slow\/start/)).toBeInTheDocument()

      // The trail lists every step of every item, each a way down.
      fireEvent.click(within(pane).getByRole('button', { name: /greet\/1\/say/ }))
      expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
      expect(chip('greet/1/say')).toHaveAttribute('aria-pressed', 'true')
    })

    it('opens the job card on Output from the right dot, and on Input from the left dot', async () => {
      const page = await openRun()

      fireEvent.click(within(page).getByRole('button', { name: 'Output of A slow server job' }))
      let pane = within(page).getByTestId('job-pane')
      expect(within(pane).getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
      expect(within(pane).getByRole('heading', { name: 'Hello report' })).toBeInTheDocument()

      fireEvent.click(within(page).getByRole('button', { name: 'Input of Confirm the report' }))
      pane = within(page).getByTestId('job-pane')
      expect(within(pane).getByRole('tab', { name: 'Input' })).toHaveAttribute('aria-selected', 'true')
      // `needs: [slow, flaky]` — what the job waited on.
      expect(within(pane).getByText('slow')).toBeInTheDocument()
      expect(within(pane).getByText('flaky')).toBeInTheDocument()
    })

    it('opens the job a bare `?step=<job>` deep link names', async () => {
      seedFinishedRun()
      renderApp(`${RUN_PATH}?step=confirm`)
      const page = screen.getByRole('main')
      await within(page).findByTestId('run-status')
      expect(within(page).getByTestId('job-pane')).toBeInTheDocument()
    })

    it('opens the step a `?step=` deep link names', async () => {
      seedFinishedRun()
      renderApp(`${RUN_PATH}?step=flaky/0/boom`)
      const page = screen.getByRole('main')
      await within(page).findByTestId('run-status')

      expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
      expect(chip('flaky/0/boom')).toHaveAttribute('aria-pressed', 'true')
      expect(within(page).queryByTestId('run-pane')).not.toBeInTheDocument()
    })
  })

  it('concatenates the step summaries in job order', async () => {
    const page = await openRun()

    const summary = within(page).getByTestId('run-summary')
    expect(summary.textContent).toContain('Said')
    expect([...summary.querySelectorAll('strong')].map((el) => el.textContent)).toEqual([
      'Hello, world!',
      'Hello, studio!',
    ])
  })

  it('jumps to the step an annotation came from', async () => {
    const page = await openRun()

    const annotations = within(page).getByTestId('annotations')
    expect(within(annotations).getByText('Job job_hello_1 took 1234 ms')).toBeInTheDocument()
    expect(within(annotations).getByText('boom failed with TEAPOT')).toBeInTheDocument()

    fireEvent.click(within(annotations).getByRole('button', { name: 'slow/0/start' }))

    expect(chip('slow/0/start')).toHaveAttribute('aria-pressed', 'true')
  })

  // Task 13: an output the writer offloaded is a `{"$file"}` pointer in the
  // row; the page must show the *value*, because that is what the workflow
  // author declared and what every renderer is written against.
  describe('an offloaded {"$file"} output', () => {
    const REPORT = '## Offloaded report\n\n- from the bucket\n'
    const PATH = 'workflows/hello/hello/runs/run_offload/slow/0/start/report.json'

    /** Rewrite `slow/0/start`'s `report` output as a pointer, with its JSON in the mock bucket. */
    function offloadReport(): void {
      seedFinishedRun()
      const bytes = new TextEncoder().encode(JSON.stringify(REPORT))
      db.files.set(PATH, { bytes, contentType: 'application/json' })
      const key = stepRowKey(FIXTURE_RUN_ID, 'slow/0/start')
      const step = db.steps.get(key)!
      db.steps.set(key, {
        ...step,
        outputs: {
          ...(step.outputs as Record<string, unknown>),
          report: {
            $file: {
              path: PATH,
              name: 'report.json',
              contentType: 'application/json',
              size: bytes.byteLength,
              url: fileUrl(PATH),
            },
          },
        },
      })
    }

    it('renders the payload it points to, through the declared renderer', async () => {
      offloadReport()
      renderApp()
      const page = screen.getByRole('main')
      await within(page).findByTestId('run-status')

      const pane = openTab(page, 'slow/0/start', 'Output')

      expect(within(pane).getByRole('heading', { name: 'Offloaded report' })).toBeInTheDocument()
      expect(within(pane).getByText('from the bucket')).toBeInTheDocument()
    })

    it('shows a payload-unavailable chip — not a crash — when the bytes cannot be read', async () => {
      offloadReport()
      server.use(http.get('/api/uploads/*', () => new HttpResponse(null, { status: 500 })))
      renderApp()
      const page = screen.getByRole('main')
      await within(page).findByTestId('run-status')

      const pane = openTab(page, 'slow/0/start', 'Output')

      expect(within(pane).getByTestId('payload-unavailable')).toHaveTextContent(/payload unavailable/)
      // The rest of the row still renders — one bad payload is not a bad page.
      expect(within(pane).getByAltText('poster.png')).toBeInTheDocument()
    })
  })

  it('reports a run id nothing was recorded for', async () => {
    renderApp('/hello/hello/runs/run_missing')

    const page = screen.getByRole('main')
    expect(await within(page).findByText('No such run')).toBeInTheDocument()
  })

  it('tells a failed read apart from a run that does not exist', async () => {
    seedFinishedRun()
    server.use(
      http.get('/api/workflow/run', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )

    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText("Couldn't load this run")).toBeInTheDocument()
    expect(within(page).queryByText('No such run')).not.toBeInTheDocument()
    expect(within(page).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('still shows the record when the definition snapshot is missing', async () => {
    db.runs.set('run_bare', {
      ...FINISHED_RUN.run,
      runId: 'run_bare',
      definition: null,
      yaml: '',
      _id: nextId(),
    })

    renderApp('/hello/hello/runs/run_bare')

    const page = screen.getByRole('main')
    expect(await within(page).findByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')
    expect(within(page).queryByTestId('job')).not.toBeInTheDocument()
    expect(within(page).getByText(/read-only record/i)).toBeInTheDocument()
  })

  /**
   * Delete (05 retention): the header only offers it when the *server* would
   * allow it, so the affordance is a mirror of the gate rather than a second
   * policy — a member sees it on their own terminal run, an admin on anyone's,
   * and neither sees it while the run is still going.
   */
  describe('deleting a run', () => {
    /** The mock session that started the fixture run. */
    const asOwner = () =>
      setMockUser({ id: 'user_fixture', email: 'fixture@example.test', role: 'user' })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('offers Delete to the member who started the run', async () => {
      asOwner()
      const page = await openRun()

      expect(await within(page).findByTestId('run-delete')).toBeInTheDocument()
    })

    it('offers no Delete to a member who did not start the run', async () => {
      setMockUser({ id: 'someone_else', email: 'else@example.test', role: 'user' })
      const page = await openRun()

      // The shell's user chip proves the whoami answer has landed — without it
      // this would pass merely because the query had not resolved yet.
      expect(await screen.findByTestId('whoami')).toHaveTextContent('else@example.test')
      expect(within(page).queryByTestId('run-delete')).not.toBeInTheDocument()
    })

    it("offers Delete to an admin on someone else's run", async () => {
      setMockUser(MOCK_ADMIN)
      const page = await openRun()

      expect(await within(page).findByTestId('run-delete')).toBeInTheDocument()
    })

    it('deletes the record and leaves for Past runs', async () => {
      asOwner()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const page = await openRun()

      fireEvent.click(await within(page).findByTestId('run-delete'))

      // The heading, not the header's own "Past runs" *link* — that link is
      // still in the document when the query first runs and is detached by the
      // navigation a tick later.
      expect(await screen.findByRole('heading', { name: 'Past runs' })).toBeInTheDocument()
      // The record itself is gone, so the list it landed on has nothing left.
      expect(await screen.findByText('No runs yet')).toBeInTheDocument()
      expect(db.runs.has(FIXTURE_RUN_ID)).toBe(false)
      expect(screen.queryByTestId('run-status')).not.toBeInTheDocument()
    })

    it('stays on the run and says why when the server refuses (403)', async () => {
      asOwner()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      server.use(
        http.post('/api/workflow/run/delete', () =>
          HttpResponse.json({ ok: false, error: 'nope' }, { status: 403 }),
        ),
      )
      const page = await openRun()

      fireEvent.click(await within(page).findByTestId('run-delete'))

      const failed = await within(page).findByTestId('run-delete-failed')
      expect(failed).toHaveTextContent(/only the run's owner or an admin/i)
      expect(within(page).getByTestId('run-status')).toBeInTheDocument()
      expect(db.runs.has(FIXTURE_RUN_ID)).toBe(true)
    })

    it('says to cancel the run first when the server refuses (409)', async () => {
      asOwner()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      server.use(
        http.post('/api/workflow/run/delete', () =>
          HttpResponse.json({ ok: false, error: 'nope' }, { status: 409 }),
        ),
      )
      const page = await openRun()

      fireEvent.click(await within(page).findByTestId('run-delete'))

      expect(await within(page).findByTestId('run-delete-failed')).toHaveTextContent(
        /cancel the run first/i,
      )
    })
  })
})
