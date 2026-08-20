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
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from '../App'
import { db, nextId, seedFinishedRun } from '../mocks/db'
import { FINISHED_RUN, FIXTURE_RUN_ID } from '../mocks/fixtures/finishedRun'
import { makeStore } from '../store'

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
    expect(within(page).getByText('Hello workflow')).toBeInTheDocument()
    expect(within(page).getByText(FIXTURE_RUN_ID)).toBeInTheDocument()
    expect(within(page).getByText('user_fixture')).toBeInTheDocument()
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

  it('details the attempt, the pipeline path and the annotations of a step', async () => {
    const page = await openRun()
    const pane = openTab(page, 'slow/0/start', 'Details')

    expect(within(pane).getByText('Attempt 2')).toBeInTheDocument()
    expect(within(pane).getByText('slow')).toBeInTheDocument()
    expect(within(pane).getByText('Job job_hello_1 took 1234 ms')).toBeInTheDocument()
    // The BUSY error of the attempt it retried is still on the row.
    expect(within(pane).getByText(/BUSY/)).toBeInTheDocument()
  })

  it("lists the run's own outputs before the per-job step outputs", async () => {
    const page = await openRun()

    const outputs = within(page).getByTestId('run-outputs')
    const names = [...outputs.querySelectorAll('[data-output]')].map((el) =>
      el.getAttribute('data-output'),
    )

    expect(names.slice(0, 3)).toEqual(['report', 'poster', 'lines'])
    expect(names.slice(3).every((name) => name!.includes('/'))).toBe(true)
    expect(names).toContain('greet/0/say.line')
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

  it('reports a run id nothing was recorded for', async () => {
    renderApp('/hello/hello/runs/run_missing')

    const page = screen.getByRole('main')
    expect(await within(page).findByText('No such run')).toBeInTheDocument()
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
})
