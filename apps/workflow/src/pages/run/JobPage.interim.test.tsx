/**
 * The step-pane's own content on the interim job page (08): a finished run's
 * step read back off the rendered DOM, reached from the Summary's chip —
 * where a value came from, its declared renderer, a waiting form's evaluated
 * `with`, and the attempt/pipeline/annotation detail on Output.
 *
 * Split out of the old single-page `RunPage.test.tsx` (spec 2026-09-08): these
 * cases are about the *pane's* content, not the Summary's graph or run card —
 * `RunShell.summary.test.tsx` keeps those.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from '../../App'
import { db, seedFinishedRun, stepRowKey } from '../../mocks/db'
import { FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { server } from '../../mocks/server'
import { makeStore } from '../../store'
import { fileUrl } from '../../lib/coerce'

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

/** The seeded run, rendered and settled, on the Summary route. */
async function openRun() {
  seedFinishedRun()
  renderApp()
  const page = screen.getByRole('main')
  await within(page).findByTestId('run-status')
  return page
}

/** Select a step from the Summary's chip and switch its pane to one tab. */
function openTab(page: HTMLElement, key: string, tab: string): HTMLElement {
  fireEvent.click(chip(key)!)
  // Scoped to the step-pane: the interim job page renders it alongside the
  // job-pane, and both carry an Input | Output tablist of their own.
  const pane = within(page).getByTestId('step-pane')
  fireEvent.click(within(pane).getByRole('tab', { name: tab }))
  return within(page).getByTestId('step-pane')
}

describe('JobPage — the step-pane (interim)', () => {
  it('labels a step input with where its value came from', async () => {
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
})
