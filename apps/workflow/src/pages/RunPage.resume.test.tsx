/**
 * The resume half of the page contract (07/D12, ADR-0006): `?resume=1`.
 *
 * A driver that parked a run comes back to it with a fresh page load — there
 * is nobody to click *Resume*, so the page adopts the lease by itself when the
 * URL asked it to. The two answers the lease can give are both facts the
 * driver reads off `window.__workflow`: adopted (the run is this tab's again,
 * and the global tracks it live) or refused because someone else holds it,
 * which is the `busy` page state — never a run status, since the row behind it
 * is a perfectly ordinary `running` one.
 *
 * The third answer is `parked`: a driven resume (`?resume=1&wait=park`) whose
 * only remaining step still needs a person hands the lease straight back.
 *
 * The record used throughout is the waiting-run fixture: a `running` row whose
 * only non-terminal step is a `review` form nobody has answered. Its stored
 * definition declares `headless: skip` for that form, which is a step a
 * headless run answers by itself — so the park cases seed the record `driven`,
 * which strips that declaration and makes the run headless.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import App from '../App'
import { publishWorkflowGlobal } from '../lib/workflowGlobal'
import { db, nextId, stepRowKey } from '../mocks/db'
import { WAITING_RUN, WAITING_STEP_KEY } from '../mocks/fixtures/waitingRun'
import { FINISHED_RUN } from '../mocks/fixtures/finishedRun'
import type { ServerRunRow } from '../lib/coerce'
import { makeStore } from '../store'

afterEach(() => {
  publishWorkflowGlobal(null)
})

type Lease = Pick<ServerRunRow, 'leaseOwner' | 'leaseUntil'>

/**
 * The fixture's stored definition with the `review` form's `headless:` stripped
 * out — the step a driven run genuinely parks on. `hello`'s own review declares
 * `headless: { mode: skip }`, i.e. a step a headless run answers by itself, so
 * a run waiting on *that* is still driving itself and must never park.
 */
function undeclaredReviewDefinition(): unknown {
  const def = structuredClone(WAITING_RUN.run.definition) as {
    jobs: Record<string, { steps: Record<string, unknown>[] }>
  }
  for (const step of def.jobs.confirm.steps) delete step.headless
  return def
}

/**
 * The still-in-flight fixture under a chosen id and lease.
 *
 * `driven` makes it the record a *driver* left behind: `headless`, and with the
 * waiting form undeclared. Both matter to `parkIfIdle`, which reads them off
 * the replayed record rather than off the URL — the URL only says whether this
 * tab was asked to park.
 */
function seedRunning(runId: string, lease: Lease, driven = false): void {
  db.runs.set(runId, {
    ...WAITING_RUN.run,
    runId,
    ...(driven ? { headless: true, definition: undeclaredReviewDefinition() } : {}),
    ...lease,
    _id: nextId(),
  })
  for (const step of WAITING_RUN.steps) {
    db.steps.set(stepRowKey(runId, step.key), { ...step, runId, _id: nextId() })
  }
}

/** The finished fixture under a chosen id — a run `?resume=1` must leave alone. */
function seedFinished(runId: string): void {
  db.runs.set(runId, { ...FINISHED_RUN.run, runId, _id: nextId() })
  for (const step of FINISHED_RUN.steps) {
    db.steps.set(stepRowKey(runId, step.key), { ...step, runId, _id: nextId() })
  }
}

function renderRun(runId: string, query = '') {
  const store = makeStore()
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/hello/hello/runs/${runId}${query}`]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
  return store
}

describe('RunPage — `?resume=1`', () => {
  it('adopts a free lease without anyone clicking Resume', async () => {
    seedRunning('run_resume_free', { leaseOwner: null, leaseUntil: null })

    const store = renderRun('run_resume_free', '?resume=1')

    // Nothing is clicked anywhere in this test: the page takes the lease off
    // the URL alone, which is the whole point of the driver's resume.
    await waitFor(() => expect(store.getState().run.mode).toBe('live'))
    expect(store.getState().run.state?.runId).toBe('run_resume_free')
    expect(db.runs.get('run_resume_free')?.leaseOwner).toBeTruthy()

    await waitFor(() => expect(window.__workflow?.runId).toBe('run_resume_free'))
    expect(window.__workflow?.status).toBe('running')
    expect(window.__workflow?.steps[WAITING_STEP_KEY]).toBe('waiting')
    // Adopted, so there is no banner to click: the offer is only made to a tab
    // that is *not* driving the run.
    const page = screen.getByRole('main')
    expect(within(page).queryByTestId('run-resume')).not.toBeInTheDocument()
  })

  it('publishes `busy` when another tab holds the lease, and stays read-only', async () => {
    seedRunning('run_resume_held', { leaseOwner: 'tab_other', leaseUntil: Date.now() + 60_000 })

    const store = renderRun('run_resume_held', '?resume=1')

    // The attempt happened and was refused: the slice holds the *replayed*
    // record read-only, and the row's lease is untouched.
    await waitFor(() => expect(store.getState().run.mode).toBe('readonly'))
    expect(db.runs.get('run_resume_held')?.leaseOwner).toBe('tab_other')

    await waitFor(() => expect(window.__workflow?.status).toBe('busy'))
    expect(window.__workflow?.runId).toBe('run_resume_held')
    const page = screen.getByRole('main')
    expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'busy')
  })

  // 07 `wait=park` (ADR-0006): the resume path has to make the same park
  // decision the schedule pass makes for a run this tab started, or a driver
  // that re-opens a parked run with `?resume=1&wait=park` adopts the lease and
  // then sits on it — heartbeating a run whose only remaining step is a
  // question for a person — until its own `--timeout` kills it.
  it('parks again when the resumed run has only a person left to wait for', async () => {
    seedRunning('run_resume_park', { leaseOwner: null, leaseUntil: null }, true)

    const store = renderRun('run_resume_park', '?resume=1&wait=park')

    await waitFor(() => expect(store.getState().run.mode).toBe('parked'))
    // The lease this page took a moment ago is handed back, so the *next* leg
    // of the drive can adopt it without waiting for the 60 s lapse.
    await waitFor(() => expect(db.runs.get('run_resume_park')?.leaseOwner).toBeNull())
    await waitFor(() => expect(window.__workflow?.status).toBe('parked'))
    expect(window.__workflow?.runId).toBe('run_resume_park')
    expect(window.__workflow?.steps[WAITING_STEP_KEY]).toBe('waiting')
  })

  // The control: same record, same waiting form — a resume that did not ask to
  // park keeps driving it, because a person may be about to answer in this tab.
  it('stays live on a plain `?resume=1`, park or no park to be had', async () => {
    seedRunning('run_resume_live', { leaseOwner: null, leaseUntil: null }, true)

    const store = renderRun('run_resume_live', '?resume=1')

    await waitFor(() => expect(store.getState().run.mode).toBe('live'))
    await waitFor(() => expect(window.__workflow?.status).toBe('running'))
    expect(db.runs.get('run_resume_live')?.leaseOwner).toBeTruthy()
  })

  it('leaves a terminal run alone — the global reads its own status', async () => {
    seedFinished('run_resume_done')

    const store = renderRun('run_resume_done', '?resume=1')

    await waitFor(() => expect(window.__workflow?.status).toBe('succeeded'))
    expect(window.__workflow?.runId).toBe('run_resume_done')
    // Nothing adopted: a finished run has nothing to drive, so no lease was
    // ever asked for and the slice was never touched.
    expect(store.getState().run.mode).toBeNull()
    expect(db.runs.get('run_resume_done')?.leaseOwner).toBeNull()
  })
})
