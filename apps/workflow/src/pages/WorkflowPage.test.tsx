/**
 * The workflow screen (08): the definition graph, the way into a run, and the
 * runs already behind it — and, for a workflow that does not validate, the lint
 * report *without* a way to start one (08's "no Start" rule).
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import App from '../App'
import helloYaml from '../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../lib/runner/definition'
import { db, MOCK_MEMBER, seedFinishedRun } from '../mocks/db'
import { FIXTURE_RUN_ID } from '../mocks/fixtures/finishedRun'
import { server } from '../mocks/server'
import { makeStore } from '../store'

const YAML_URL = '/w/hello/.bffless/workflows/hello.workflow.yaml'

/**
 * How many jobs the graph owes the screen — read off the definition the mock
 * actually serves, not written down here. `hello.workflow.yaml` lives in
 * `bffless/workflow-implementations` and gains a job whenever that repo grows one
 * (apps#380); what this page promises is *every* job, not four of them.
 */
const HELLO_JOBS = Object.keys(loadWorkflow(helloYaml, 'hello.workflow.yaml').def!.jobs).length

function renderApp(path = '/hello/hello') {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

describe('WorkflowPage', () => {
  it('renders the definition graph and the way into a run', async () => {
    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText('Hello workflow')).toBeInTheDocument()
    expect(await within(page).findAllByTestId('job')).toHaveLength(HELLO_JOBS)
    expect(within(page).getByRole('link', { name: 'Start a run' })).toHaveAttribute(
      'href',
      '/hello/hello/run',
    )
    expect(within(page).getByRole('link', { name: 'View workflow file' })).toHaveAttribute(
      'href',
      '/hello/hello/file',
    )
  })

  /**
   * Definition mode's own run › job › step (spec §The workflow page): the graph
   * names a job, the job's declared steps are rows under it, and a row expands
   * to what that step declares. `report` is asserted *inside* the job page: the
   * graph node above says the same word for the job's own output, and the point
   * here is that the row's OUT line says it for the step.
   */
  it('lists a job’s declared steps under the graph on a node click, and expands one to its declaration', async () => {
    renderApp()

    const page = screen.getByRole('main')
    await within(page).findAllByTestId('job')
    fireEvent.click(document.querySelector('[data-testid="job"][data-job="slow"]')!)

    const jobPage = within(page).getByTestId('job-page')
    expect(jobPage).toHaveAttribute('data-job', 'slow')
    expect(within(jobPage).getByTestId('job-head')).toHaveTextContent('A slow server job')

    const rows = within(jobPage).getAllByTestId('step')
    expect(rows[0]).toHaveAttribute('data-state', 'declared')
    expect(rows[0]).toHaveAttribute('data-key', 'slow/0/start')

    fireEvent.click(rows[0]!)

    expect(within(jobPage).getByTestId('step-declaration')).toHaveTextContent('"path": "slow"')
    expect(within(jobPage).getByText('report')).toBeInTheDocument()
  })

  it('presses the graph node whose steps are listed, and lists nothing before the first click', async () => {
    renderApp()

    const page = screen.getByRole('main')
    await within(page).findAllByTestId('job')
    // The nodes are a group of toggles with nothing pressed yet, and no job
    // page under the graph until one of them is.
    for (const card of within(page).getAllByTestId('job')) {
      expect(card).toHaveAttribute('aria-pressed', 'false')
    }
    expect(within(page).queryByTestId('job-page')).not.toBeInTheDocument()

    fireEvent.click(document.querySelector('[data-testid="job"][data-job="slow"]')!)

    expect(document.querySelector('[data-testid="job"][data-job="slow"]')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(document.querySelector('[data-testid="job"][data-job="greet"]')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('lists the most recent runs with their status', async () => {
    seedFinishedRun()
    renderApp()

    const page = screen.getByRole('main')
    const link = await within(page).findByRole('link', { name: new RegExp(FIXTURE_RUN_ID) })
    expect(link).toHaveAttribute('href', `/hello/hello/runs/${FIXTURE_RUN_ID}`)
    expect(within(page).getByText('Succeeded')).toHaveAttribute('data-state', 'succeeded')
  })

  /**
   * "Recent runs" reads the same list query Past runs does, so it sees the
   * dispatched runs nobody has picked up yet too (apps#671). It shows only a
   * pill, an id and a time — all three of which a queued entry has — so it
   * needs no branch of its own: what it must not do is drop the newest thing
   * that happened to this workflow on the floor.
   */
  it('shows a dispatched run among them, as Queued (apps#671)', async () => {
    const QUEUED_RUN_ID = 'run_dispatched'
    seedFinishedRun()
    db.claims.set(QUEUED_RUN_ID, {
      runId: QUEUED_RUN_ID,
      impl: 'hello',
      workflow: 'hello',
      startedBy: MOCK_MEMBER.id,
      startedByEmail: MOCK_MEMBER.email,
      driveKey: 'nonce-abc',
      createdAt: Date.parse('2026-09-11T10:00:00Z'),
    })
    renderApp()

    const page = screen.getByRole('main')
    const link = await within(page).findByRole('link', { name: new RegExp(QUEUED_RUN_ID) })
    expect(link).toHaveAttribute('href', `/hello/hello/runs/${QUEUED_RUN_ID}`)
    expect(within(page).getByText('Queued')).toHaveAttribute('data-state', 'queued')
    // And the runs themselves are still there, newest first.
    expect(within(page).getByRole('link', { name: new RegExp(FIXTURE_RUN_ID) })).toBeInTheDocument()
  })

  it('reports the lint errors and offers no Start when the workflow does not validate', async () => {
    server.use(http.get(YAML_URL, () => HttpResponse.text('spec: 1\nname: broken\njobs: 42\n')))

    renderApp()

    const page = screen.getByRole('main')
    expect(await within(page).findByText('must be object')).toBeInTheDocument()
    expect(within(page).queryByRole('link', { name: 'Start a run' })).not.toBeInTheDocument()
    expect(within(page).queryByTestId('job')).not.toBeInTheDocument()
    expect(within(page).getByRole('link', { name: 'View workflow file' })).toBeInTheDocument()
  })
  it('reports an unknown workflow id with a link back to the implementation', async () => {
    renderApp('/hello/nope')

    const page = screen.getByRole('main')
    expect(await within(page).findByText('No such workflow')).toBeInTheDocument()
    // Not `..`: under the pathless Shell layout route that resolves to `/`.
    expect(within(page).getByRole('link', { name: 'Back to its workflows' })).toHaveAttribute(
      'href',
      '/hello',
    )
  })
})
