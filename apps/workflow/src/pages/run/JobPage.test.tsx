/**
 * The job page (spec 2026-09-08, phase 3): a head, the job's own values behind
 * a disclosure, and the steps as rows that expand in place.
 *
 * Three readings of the same URL are proved here — the plain/item step list,
 * the matrix collect view, and the error redirects — together with the
 * step-body content this suite inherited from `JobPage.interim.test.tsx`
 * (input origins, declared renderers, a waiting form's evaluated `with`, the
 * attempt/pipeline/annotation detail, an offloaded `{"$file"}` output) and the
 * fork slot it inherited from `JobPane.test.tsx`. Both used to be read
 * through a step *pane* rendered beside a job *pane*; the row and the job head
 * carry them now, so every one of those assertions is made against the same
 * DOM a person actually reads.
 *
 * `createMemoryRouter` + `RouterProvider` (the helper `RunShell.selection.test.tsx`
 * uses) rather than `<MemoryRouter initialEntries>`: expanding a row *is* a
 * navigation now, so most cases have to read `router.state.location` back.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import { RouterProvider, createMemoryRouter, createRoutesFromElements } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { fileUrl } from '../../lib/coerce'
import { db, seedFinishedRun, stepRowKey } from '../../mocks/db'
import { FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { server } from '../../mocks/server'
import { routes } from '../../routes'
import { makeStore } from '../../store'
import { workflowApi } from '../../store/workflowApi'

const RUN_PATH = `/hello/hello/runs/${FIXTURE_RUN_ID}`

/** The seeded run, opened straight at one of its job URLs. */
async function openAt(path: string) {
  seedFinishedRun()
  const store = makeStore()
  const router = createMemoryRouter(createRoutesFromElements(routes), { initialEntries: [path] })
  render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  )
  const page = screen.getByRole('main')
  await within(page).findByTestId('run-status')
  return { page, router, store }
}

/** One step's row head, by the key it carries (the headless contract, 07). */
function rowFor(page: HTMLElement, key: string): HTMLElement {
  return page.querySelector(`[data-testid="step"][data-key="${key}"]`) as HTMLElement
}

/** Expand a step's row and switch its body to one side. */
function openTab(page: HTMLElement, key: string, tab: string): HTMLElement {
  fireEvent.click(rowFor(page, key))
  const body = within(page).getByTestId('step-pane')
  fireEvent.click(within(body).getByRole('tab', { name: tab }))
  return within(page).getByTestId('step-pane')
}

describe('JobPage — the step rows', () => {
  it('lists the job’s steps as rows, closed, with their status and duration', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/slow/0`)

    const rows = within(page).getAllByTestId('step')
    expect(rows.map((r) => r.getAttribute('data-key'))).toEqual(['slow/0/start'])
    expect(rows[0]).toHaveAttribute('data-state', 'succeeded')
    expect(rows[0]).toHaveAttribute('aria-expanded', 'false')
    expect(rows[0]).toHaveTextContent('7.0 s')
    expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()
    expect(within(page).getByTestId('job-page')).toHaveAttribute('data-job', 'slow')
  })

  it('expands the row `?step=` names on arrival, and a click writes `?step=` and opens another', async () => {
    const { page, router } = await openAt(`${RUN_PATH}/job/flaky/0?step=flaky%2F0%2Fboom`)

    await waitFor(() => expect(within(page).getAllByTestId('step-pane')).toHaveLength(1))

    fireEvent.click(within(page).getByRole('button', { name: /after/ }))
    expect(router.state.location.search).toBe('?step=flaky%2F0%2Fafter')
    // Any number of rows may be open at once (Decision 7): opening one never
    // shuts the one a person was reading.
    expect(within(page).getAllByTestId('step-pane')).toHaveLength(2)

    // Collapsing the one `?step=` names leaves the job with no step named.
    fireEvent.click(within(page).getByRole('button', { name: /after/ }))
    expect(router.state.location.search).toBe('')
    expect(router.state.location.pathname).toBe(`${RUN_PATH}/job/flaky/0`)
    expect(within(page).getAllByTestId('step-pane')).toHaveLength(1)
  })

  it('never opens a step the run has not reached', async () => {
    // `confirm` needs `slow` and `flaky`; seed a run that stopped before it.
    seedFinishedRun()
    for (const key of ['confirm/0/review']) db.steps.delete(stepRowKey(FIXTURE_RUN_ID, key))
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`${RUN_PATH}/job/confirm/0`],
    })
    render(
      <Provider store={makeStore()}>
        <RouterProvider router={router} />
      </Provider>,
    )
    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')

    const row = rowFor(page, 'confirm/0/review')
    expect(row).toBeDisabled()
    expect(row).toHaveAttribute('data-state', 'queued')
    fireEvent.click(row)
    expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()
    expect(router.state.location.search).toBe('')
  })
})

describe('JobPage — the matrix', () => {
  it('shows the collect view for a matrix job: collected outputs and one row per item', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/greet`)

    expect(within(page).getByTestId('job-items').querySelectorAll('a')).toHaveLength(2)
    fireEvent.click(within(page).getByText('Job inputs and outputs'))
    fireEvent.click(within(page).getByRole('tab', { name: 'Output' }))
    expect(within(page).getByTestId('job-io')).toHaveTextContent('Hello, studio!')
    expect(within(page).getByTestId('job-io')).toHaveTextContent('Hello, world!')
    // No step rows at all: 2 items × 1 step says nothing about which leg is which.
    expect(within(page).queryByTestId('job-steps')).not.toBeInTheDocument()
  })

  it('shows an item’s own bindings and its element of the collected outputs', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/greet/1`)

    expect(within(page).getByTestId('job-head')).toHaveTextContent('item 2 of 2')
    fireEvent.click(within(page).getByText('Job inputs and outputs'))
    expect(within(page).getByTestId('job-io')).toHaveTextContent('who')
    fireEvent.click(within(page).getByRole('tab', { name: 'Output' }))
    expect(within(page).getByTestId('job-io')).toHaveTextContent('Hello, studio!')
    expect(within(page).getByTestId('job-io')).not.toHaveTextContent('Hello, world!')
    // The item's own leg, not the whole fan-out.
    expect(within(page).getAllByTestId('step').map((r) => r.getAttribute('data-key'))).toEqual([
      'greet/1/say',
    ])
  })

  it("an item's link goes to that item's own page", async () => {
    const { page, router } = await openAt(`${RUN_PATH}/job/greet`)

    fireEvent.click(within(page).getByTestId('job-items').querySelectorAll('a')[1]!)

    expect(router.state.location.pathname).toBe(`${RUN_PATH}/job/greet/1`)
    expect(within(page).getByTestId('job-head')).toHaveTextContent('item 2 of 2')
  })
})

describe('JobPage — the job disclosure', () => {
  it('opens the job disclosure on the side an edge dot asked for', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/slow?tab=Output`)

    expect(within(page).getByTestId('job-io')).toHaveAttribute('open')
    expect(within(page).getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
    expect(within(page).getByTestId('job-io')).toHaveTextContent('report')
  })

  // Fix round 1: a row click is a navigation — it writes `?step=` (which
  // always carries the item index) and drops `?tab=`. Anything the disclosure
  // derived from those, or was keyed on, went with it: the first expand
  // snapped it shut and reverted it to Input.
  it('keeps the side an edge dot asked for when a step row is expanded under it', async () => {
    const { page, router } = await openAt(`${RUN_PATH}/job/slow?tab=Output`)

    expect(within(page).getByTestId('job-io')).toHaveAttribute('open')
    expect(within(page).getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(rowFor(page, 'slow/0/start'))

    // The route moved to the step — the item index arrives, `?tab=` does not …
    expect(router.state.location.pathname).toBe(`${RUN_PATH}/job/slow/0`)
    expect(router.state.location.search).toBe('?step=slow%2F0%2Fstart')
    // … and the disclosure is exactly as the person left it.
    expect(within(page).getByTestId('job-io')).toHaveAttribute('open')
    expect(
      within(within(page).getByTestId('job-io')).getByRole('tab', { name: 'Output' }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(within(page).getByTestId('job-io')).toHaveTextContent('report')
  })

  it('stays open when a step row is expanded after the person opened it themselves', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/slow`)

    fireEvent.click(within(page).getByText('Job inputs and outputs'))
    expect(within(page).getByTestId('job-io')).toHaveAttribute('open')

    fireEvent.click(rowFor(page, 'slow/0/start'))

    expect(within(page).getByTestId('job-io')).toHaveAttribute('open')
    expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
  })

  it('is closed with nothing asked for, and opens on the summary', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/slow`)

    const io = within(page).getByTestId('job-io')
    expect(io).not.toHaveAttribute('open')
    fireEvent.click(within(page).getByText('Job inputs and outputs'))
    expect(within(page).getByTestId('job-io')).toHaveAttribute('open')
    // `needs: greet` — what the job waited on.
    expect(within(page).getByTestId('job-io')).toHaveTextContent('greet')
  })
})

/**
 * Automated review of PR #635, finding 1: `open`, `ioOpen` and `ioTab` used
 * to survive a job/item navigation — `routes.tsx` renders `<JobPage/>` for
 * both job routes through the same un-keyed `<Outlet/>`, so one instance was
 * reused across param changes. Fixed by keying the outlet on the job route
 * (`RunShell`'s `outletKey`), so `JobPage` remounts — and its `?step=`/`?tab=`
 * seeding runs fresh — on exactly these two moves.
 */
describe('JobPage — resets per job and per item (finding 1)', () => {
  it('closes the open row when the route moves to a different item of the same matrix job', async () => {
    const { page, router } = await openAt(`${RUN_PATH}/job/greet/0`)

    fireEvent.click(rowFor(page, 'greet/0/say'))
    expect(within(page).getByTestId('step-pane')).toBeInTheDocument()

    await act(async () => {
      await router.navigate(`${RUN_PATH}/job/greet/1`)
    })

    expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()
    // Nothing open on the new page, so the window's Esc climbs straight to
    // the Summary — the bug left `open` (and its listener) behind on `greet/0`.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(router.state.location.pathname).toBe(RUN_PATH))
  })

  it('closes the job disclosure when the route moves to a different job', async () => {
    const { page, router } = await openAt(`${RUN_PATH}/job/slow?tab=Output`)

    expect(within(page).getByTestId('job-io')).toHaveAttribute('open')

    await act(async () => {
      await router.navigate(`${RUN_PATH}/job/flaky`)
    })

    expect(within(page).getByTestId('job-io')).not.toHaveAttribute('open')
  })
})

describe('JobPage — error states', () => {
  it('redirects a `?step=` of another job to that job, keeping the other parameters', async () => {
    const { router } = await openAt(`${RUN_PATH}/job/slow/0?step=flaky%2F0%2Fboom&mocks=on`)

    expect(router.state.location.pathname).toBe(`${RUN_PATH}/job/flaky/0`)
    expect(router.state.location.search).toContain('mocks=on')
    expect(router.state.location.search).toContain('step=flaky%2F0%2Fboom')
  })

  it('redirects an item past the fan-out to the job itself', async () => {
    const { router } = await openAt(`${RUN_PATH}/job/greet/7`)

    expect(router.state.location.pathname).toBe(`${RUN_PATH}/job/greet`)
  })

  it('says so for a job this workflow does not declare', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/nope`)

    expect(within(page).getByTestId('job-head')).toBeInTheDocument()
    expect(within(page).getByText('This workflow declares no such job.')).toBeInTheDocument()
  })
})

/**
 * From `JobPage.interim.test.tsx`: the *body* a row expands into, read back
 * off the rendered DOM rather than off the state that produced it.
 */
describe('JobPage — the step body', () => {
  it('labels a step input with where its value came from', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/greet/0`)

    fireEvent.click(rowFor(page, 'greet/0/say'))
    const pane = within(page).getByTestId('step-pane')

    expect(within(pane).getByText('echo')).toBeInTheDocument()
    expect(within(pane).getByText(/from inputs\.greeting/)).toBeInTheDocument()
  })

  it("renders a step's declared outputs with their own renderers", async () => {
    const { page } = await openAt(`${RUN_PATH}/job/slow/0`)
    const pane = openTab(page, 'slow/0/start', 'Output')

    expect(within(pane).getByRole('heading', { name: 'Hello report' })).toBeInTheDocument()
    expect(within(pane).getByText('Hello, world!')).toBeInTheDocument()

    expect(within(pane).getByAltText('poster.png')).toBeInTheDocument()
    expect(within(pane).getByRole('link', { name: 'Download' }).getAttribute('href')).toContain(
      'download=1',
    )
  })

  it("shows a form step's evaluated `with` on Input — title, fields with resolved defaults, submit", async () => {
    const { page } = await openAt(`${RUN_PATH}/job/confirm/0`)
    const pane = openTab(page, 'confirm/0/review', 'Input')

    expect(within(pane).getByText('title')).toBeInTheDocument()
    expect(within(pane).getByText('Does the report look right?')).toBeInTheDocument()
    expect(within(pane).getByText('fields')).toBeInTheDocument()
    // `default: ${{ needs.slow.outputs.report }}` was evaluated before the form was shown.
    expect(within(pane).getByText(/Hello, world!/)).toBeInTheDocument()
    expect(within(pane).getByText('submit')).toBeInTheDocument()
  })

  it('details the attempt, the pipeline path and the annotations of a step on Output', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/slow/0`)
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

    /** The offloaded run at `slow`'s job page — `openAt` would re-seed over the rewrite. */
    async function openOffloaded() {
      const router = createMemoryRouter(createRoutesFromElements(routes), {
        initialEntries: [`${RUN_PATH}/job/slow/0`],
      })
      render(
        <Provider store={makeStore()}>
          <RouterProvider router={router} />
        </Provider>,
      )
      const page = screen.getByRole('main')
      await within(page).findByTestId('run-status')
      return page
    }

    it('renders the payload it points to, through the declared renderer', async () => {
      offloadReport()
      const page = await openOffloaded()

      const pane = openTab(page, 'slow/0/start', 'Output')

      expect(await within(pane).findByRole('heading', { name: 'Offloaded report' })).toBeInTheDocument()
      expect(within(pane).getByText('from the bucket')).toBeInTheDocument()
    })

    it('shows a payload-unavailable chip — not a crash — when the bytes cannot be read', async () => {
      offloadReport()
      server.use(http.get('/api/uploads/*', () => new HttpResponse(null, { status: 500 })))
      const page = await openOffloaded()

      const pane = openTab(page, 'slow/0/start', 'Output')

      expect(await within(pane).findByTestId('payload-unavailable')).toHaveTextContent(
        /payload unavailable/,
      )
      // The rest of the row still renders — one bad payload is not a bad page.
      expect(within(pane).getByAltText('poster.png')).toBeInTheDocument()
    })
  })
})

/**
 * From `JobPane.test.tsx`: the **Re-run from this job** slot, now on the job
 * head. Same contract as the run header's Delete — the shell decides whether
 * the job can be forked from (`forkable`: a terminal run, every job outside
 * the pick's downstream closure `success`/`skipped`, the alias's current
 * workflow loaded) and passes `onFork` only then; the head renders the button
 * when it is handed one, and nothing otherwise. `RunShell.summary.test.tsx`
 * owns the gate itself; this suite owns the rendering.
 */
describe('JobPage — Re-run from this job', () => {
  /** The fork runs under the alias's *current* workflow, so the button waits for it. */
  const currentWorkflowLoaded = (store: ReturnType<typeof makeStore>) =>
    waitFor(() =>
      expect(
        workflowApi.endpoints.getWorkflowYaml.select({ impl: 'hello', file: 'hello.workflow.yaml' })(
          store.getState(),
        ).data,
      ).toBeDefined(),
    )

  it('offers no fork at all when the shell passes no handler', async () => {
    // A run still in flight is never a fork point, so `forkable` says no and
    // the head is handed nothing.
    seedFinishedRun()
    db.runs.set(FIXTURE_RUN_ID, { ...db.runs.get(FIXTURE_RUN_ID)!, status: 'running', finishedAt: null })
    const store = makeStore()
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`${RUN_PATH}/job/slow/0`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )
    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')
    await currentWorkflowLoaded(store)

    expect(within(page).getByTestId('job-head')).toBeInTheDocument()
    expect(within(page).queryByTestId('job-fork')).not.toBeInTheDocument()
    expect(within(page).queryByRole('button', { name: 'Re-run from this job' })).not.toBeInTheDocument()
  })

  it('renders the button in the job head when the shell passes a handler, and calls it on click', async () => {
    // The rule refuses, so nothing is adopted into this tab — the refusal
    // banner *is* the proof the head's button reached the page's handler.
    server.use(
      http.post('/api/workflow/run/fork', () =>
        HttpResponse.json({ ok: false, error: 'only the run owner or an admin can fork a run' }, { status: 403 }),
      ),
    )
    const { page } = await openAt(`${RUN_PATH}/job/slow/0`)

    const head = within(page).getByTestId('job-head')
    const button = await within(head).findByTestId('job-fork')
    expect(button).toHaveTextContent('Re-run from this job')
    expect(button).toBeEnabled()

    fireEvent.click(button)

    expect(await within(page).findByTestId('run-fork-failed')).toHaveTextContent(
      'only the run owner or an admin can fork a run',
    )
    expect(db.runs.size).toBe(1)
  })

  it('keeps the button on both sides of the disclosure — it is an action of the job, not of a tab', async () => {
    const { page } = await openAt(`${RUN_PATH}/job/slow?tab=Input`)

    const head = within(page).getByTestId('job-head')
    expect(await within(head).findByTestId('job-fork')).toBeInTheDocument()
    fireEvent.click(within(page).getByRole('tab', { name: 'Output' }))
    expect(within(head).getByTestId('job-fork')).toBeInTheDocument()
  })
})

/**
 * Controller ruling 3: Esc out of a step lands on the page it was read on —
 * the *item*, not the job as a whole. `RunShell.back()` used to drop the index.
 */
describe('JobPage — the way up keeps a matrix item', () => {
  it('goes up to the Summary when Esc is pressed with no row open, and stops there', async () => {
    // Controller ruling 2 (spec §Follow or pinned): Esc layers — inside an
    // expanded row body it collapses that row; with nothing expanded on a job
    // page it is the crumb's Back to the Summary; on the Summary, nothing.
    const { page, router } = await openAt(`${RUN_PATH}/job/greet/1?step=greet%2F1%2Fsay`)

    await waitFor(() => expect(within(page).getByTestId('step-pane')).toBeInTheDocument())
    fireEvent.keyDown(within(page).getByTestId('step-pane'), { key: 'Escape' })
    expect(router.state.location.pathname).toBe(`${RUN_PATH}/job/greet/1`)

    // Nothing expanded now: the next Esc climbs out of the job page.
    fireEvent.keyDown(rowFor(page, 'greet/1/say'), { key: 'Escape' })
    await waitFor(() => expect(router.state.location.pathname).toBe(RUN_PATH))
    expect(within(page).getByTestId('run-outputs')).toBeInTheDocument()
    // …and the Summary is the top: Esc there moves nothing.
    fireEvent.keyDown(page, { key: 'Escape' })
    expect(router.state.location.pathname).toBe(RUN_PATH)
  })

  it('hears Esc with focus on the body — a rail link or a typed URL leaves it there', async () => {
    // Fix round 1, finding 2: the layer is a window listener, not a handler on
    // the page's own section, so it works before the person has clicked
    // anything on the page.
    const { page, router } = await openAt(`${RUN_PATH}/job/slow/0`)
    expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(document.body)

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(router.state.location.pathname).toBe(RUN_PATH))
  })

  it('climbs from a matrix item’s step to that item’s page, not the collect view', async () => {
    const { page, router } = await openAt(`${RUN_PATH}/job/greet/1?step=greet%2F1%2Fsay`)

    await waitFor(() => expect(within(page).getByTestId('step-pane')).toBeInTheDocument())
    fireEvent.keyDown(within(page).getByTestId('step-pane'), { key: 'Escape' })

    expect(router.state.location.pathname).toBe(`${RUN_PATH}/job/greet/1`)
    expect(router.state.location.search).toBe('')
    expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()
  })
})
