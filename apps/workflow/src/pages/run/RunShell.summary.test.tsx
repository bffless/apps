/**
 * The read-only run page (08): a finished run rebuilt from its rows by the
 * replay engine, and every section of the page read back off the rendered DOM
 * rather than off the state that produced it.
 *
 * The fixture run has **6** step rows (R2) but the graph draws no steps at all:
 * one node per job (spec 2026-09-08, Task 8). A step is reached in two moves —
 * its job's node on the Summary, then that step's row on the job page, where it
 * expands in place — which is also how `greet/1/say`, the sixth row, is
 * reached: through the matrix job's item link, not a chip on a card.
 *
 * Split out of the old single-page `RunShell.test.tsx` (spec 2026-09-08): the
 * Summary — its header, the run card, its outputs and annotations, delete,
 * fork, and the degraded states — stays here; the step-pane's own content
 * (input origins, renderers, a waiting form's `with`, attempt detail) moved to
 * `JobPage.test.tsx`. Selecting anything is now a navigation (the
 * Summary and a job/step are separate routes), so a case that used to prove a
 * selection by a chip's `aria-pressed` now proves it by the URL instead
 * (`createMemoryRouter` + `router.state.location`), and a case that clicked a
 * second graph element after the first now returns to the Summary between
 * the two clicks — the graph is the Summary's alone now.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import {
  MemoryRouter,
  RouterProvider,
  createMemoryRouter,
  createRoutesFromElements,
  useLocation,
} from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { MOCK_ADMIN, db, nextId, seedFinishedRun, setMockUser, stepRowKey } from '../../mocks/db'
import { FINISHED_RUN, FIXTURE_RUN_ID } from '../../mocks/fixtures/finishedRun'
import { server } from '../../mocks/server'
import { routes } from '../../routes'
import { makeStore } from '../../store'
import { runClosed } from '../../store/runSlice'
import { workflowApi } from '../../store/workflowApi'
import type { ServerRunRow } from '../../lib/coerce'

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

/** One job's node on the Summary graph — the graph's only clickable unit (Task 8). */
const node = (job: string) =>
  document.querySelector(`[data-testid="job"][data-job="${job}"]`) as HTMLElement | null

/** One step's row head on the job page, by the key it carries (07). */
function rowFor(page: HTMLElement, key: string): HTMLElement {
  return page.querySelector(`[data-testid="step"][data-key="${key}"]`) as HTMLElement
}

/**
 * A step, the way a person reaches one now: its job's node on the Summary, the
 * item's own link when the job fanned out, then that step's row — which
 * expands in place rather than replacing the page (Phase 3).
 */
function openStep(page: HTMLElement, key: string) {
  const [job, index] = key.split('/')
  fireEvent.click(node(job!)!)
  const items = within(page).queryByTestId('job-items')
  if (items) fireEvent.click(items.querySelectorAll('a')[Number(index)]!)
  fireEvent.click(rowFor(page, key))
}

/** The seeded run, rendered and settled. */
async function openRun() {
  seedFinishedRun()
  renderApp()
  const page = screen.getByRole('main')
  await within(page).findByTestId('run-status')
  return page
}

/**
 * The seeded run, rendered through an imperative `createMemoryRouter` rather
 * than a fixed `<MemoryRouter initialEntries>` — for a case that used to
 * prove a selection by a chip's `aria-pressed` and now proves it by the URL
 * the selection actually is (08).
 */
async function openRunRouter(path = RUN_PATH) {
  seedFinishedRun()
  const router = createMemoryRouter(createRoutesFromElements(routes), { initialEntries: [path] })
  render(
    <Provider store={makeStore()}>
      <RouterProvider router={router} />
    </Provider>,
  )
  const page = screen.getByRole('main')
  await within(page).findByTestId('run-status')
  return { page, router }
}

describe('RunShell', () => {
  it('shows the run header, its status and one node per job', async () => {
    const page = await openRun()

    expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')
    // Scoped to the header: the run card under the graph names the workflow
    // and the run too.
    const head = page.querySelector('.run-head') as HTMLElement
    expect(within(head).getByText('Hello workflow')).toBeInTheDocument()
    expect(within(head).getByText(FIXTURE_RUN_ID)).toBeInTheDocument()
    expect(within(head).getByText('user_fixture')).toBeInTheDocument()
    expect(within(page).getByText('12.5 s')).toBeInTheDocument()

    // Four jobs, no steps: the graph is jobs only (Task 8), and the matrix job
    // is one node carrying its own fan-out.
    expect(within(page).getAllByTestId('job')).toHaveLength(4)
    expect(within(page).queryAllByTestId('step')).toHaveLength(0)
    expect(node('greet')).toHaveTextContent('2 of 2 done')
    // Picking an item is a selection, and a selection is a navigation (08): the
    // job's own trail lands on that very step's pane — including the sixth row,
    // `greet/1/say`, which no card ever showed.
    openStep(page, 'greet/1/say')
    expect(await within(page).findByTestId('step-pane')).toBeInTheDocument()
    // The row itself carries the step's identity now (Decision 4): the open
    // body sits inside the row whose `data-key` is that very step.
    expect(rowFor(page, 'greet/1/say')).toHaveAttribute('aria-expanded', 'true')
    expect(rowFor(page, 'greet/1/say').parentElement).toContainElement(
      within(page).getByTestId('step-pane'),
    )
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

  it('replays a record carrying every machine-attached field to the run card and its outputs', async () => {
    // The exact read-back shape live run run_01M1A98WXFP83S32RJ7GVHXW1M had on
    // 2026-08-30, after #532/#535/#536 started writing new columns: the run row
    // holds `outputs` and an `annotationCounts` rollup while its own
    // `annotations` are empty (the notices live on step rows), and step rows
    // carry a `ctx.log` tail, a pipeline `logId`, and a `kind`-marked
    // annotation with an opaque `data` payload. None of it may make coerce or
    // replay throw, fold the status, or suppress the run card's outputs.
    seedFinishedRun()
    const run = db.runs.get(FIXTURE_RUN_ID)!
    db.runs.set(FIXTURE_RUN_ID, {
      ...run,
      annotations: [],
      annotationCounts: { error: 0, warning: 1, notice: 2 },
    })
    const rowKey = stepRowKey(FIXTURE_RUN_ID, 'slow/0/start')
    const row = db.steps.get(rowKey)!
    db.steps.set(rowKey, {
      ...row,
      log: ['drawing 1 of 1'],
      logId: 'log_fixture_01',
      annotations: [
        ...(row.annotations ?? []),
        {
          level: 'notice',
          message: 'diagnostics attached',
          kind: 'diagnostics',
          data: { consoleErrors: [], steps: [] },
        },
      ],
    })

    renderApp()
    const page = screen.getByRole('main')
    await within(page).findByTestId('run-status')
    expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')

    // The page condition the live walk waits on: the run card, with the
    // recorded outputs under it.
    const outputs = within(page).getByTestId('run-outputs')
    const names = [...outputs.querySelectorAll('[data-output]')].map((el) =>
      el.getAttribute('data-output'),
    )
    expect(names).toEqual(['report', 'poster', 'lines'])
    expect(within(outputs).getAllByText('Hello, world!').length).toBeGreaterThan(0)
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

  // Two levels now (Phase 3): the Summary, and a job page whose step rows
  // expand in place. A job replaces the run card; collapsing the open row is
  // the way out of a step, and the job head's "Run" crumb the way out of a job.
  describe('the run and job pages take turns', () => {
    it('replaces the run card with the job page on a job node then its step row; collapsing climbs to the job, the crumb to the run', async () => {
      const { page, router } = await openRunRouter()

      openStep(page, 'slow/0/start')
      expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
      expect(within(page).queryByTestId('run-pane')).not.toBeInTheDocument()
      expect(within(page).queryByTestId('run-outputs')).not.toBeInTheDocument()
      // The node's own `aria-pressed` no longer applies at the step level — the
      // selection *is* the route now, so the way this pins is a URL, not a DOM
      // attribute.
      expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/slow/0`)
      expect(router.state.location.search).toBe('?step=slow%2F0%2Fstart')

      // Collapsing the open row is the way up a level: the job page stays, and
      // the URL keeps the item it was read on — only `?step=` goes (ruling 3).
      fireEvent.click(rowFor(page, 'slow/0/start'))
      expect(within(page).getByTestId('job-page')).toBeInTheDocument()
      expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()
      expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/slow/0`)
      expect(router.state.location.search).toBe('')

      // The job head's own crumb climbs to the Summary.
      fireEvent.click(within(within(page).getByTestId('job-head')).getByRole('button', { name: 'Run' }))
      expect(within(page).getByTestId('run-pane')).toBeInTheDocument()
      expect(within(page).queryByTestId('job-page')).not.toBeInTheDocument()
      expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
    })

    it("climbs straight to the run on the job head's Run crumb", async () => {
      const page = await openRun()
      openStep(page, 'slow/0/start')
      fireEvent.click(within(within(page).getByTestId('job-head')).getByRole('button', { name: 'Run' }))
      expect(within(page).getByTestId('run-pane')).toBeInTheDocument()
    })

    it('closes the open row on Esc, and on the row head clicked again', async () => {
      const page = await openRun()

      openStep(page, 'slow/0/start')
      fireEvent.keyDown(within(page).getByTestId('step-pane'), { key: 'Escape' })
      expect(within(page).getByTestId('job-page')).toBeInTheDocument()
      expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()

      // The graph has no step to click at all now — the job page's own step
      // rows are the only way down to one from here.
      fireEvent.click(rowFor(page, 'slow/0/start'))
      expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
      // The open row, clicked again, closes — the toggle a pressed chip used to give.
      fireEvent.click(rowFor(page, 'slow/0/start'))
      expect(within(page).getByTestId('job-page')).toBeInTheDocument()
      expect(within(page).queryByTestId('step-pane')).not.toBeInTheDocument()
    })

    it("opens the job card from the job's own graph node, with the job's evaluated outputs", async () => {
      const { page, router } = await openRunRouter()

      // The node carries no `aria-label`, so its accessible name is its own
      // content — the job's label *and* what it says about the run. (A
      // `{ name: /Greet each name/ }` role query would be ambiguous here: the
      // job's two edge dots are named after it too.)
      expect(node('greet')).toHaveAccessibleName(/Greet each name/)
      expect(node('greet')).toHaveAccessibleName(/2 of 2 done/)
      fireEvent.click(node('greet')!)
      const head = within(page).getByTestId('job-head')
      // The crumb says which level this is; the title names the job.
      expect(within(head).getByRole('heading', { name: 'Greet each name' })).toBeInTheDocument()
      expect(within(head).getByRole('navigation', { name: /where this sits/i })).toHaveTextContent(
        /^Run›Job$/,
      )

      // The job's own values are one disclosure down now (Phase 3).
      fireEvent.click(within(page).getByText('Job inputs and outputs'))
      fireEvent.click(within(page).getByRole('tab', { name: 'Output' }))
      const io = within(page).getByTestId('job-io')
      // `lines: ${{ steps.say.outputs.line }}` collects across the matrix (01).
      expect(within(io).getByText('lines')).toBeInTheDocument()
      expect(within(io).getByText('Hello, world!')).toBeInTheDocument()
      expect(within(io).getByText('Hello, studio!')).toBeInTheDocument()
      // …and goes to the step that reads it.
      expect(within(io).getByText(/goes to slow\/start/)).toBeInTheDocument()

      // The collect view lists every item, each a way down to its own leg.
      fireEvent.click(within(page).getByTestId('job-items').querySelectorAll('a')[1]!)
      fireEvent.click(rowFor(page, 'greet/1/say'))
      expect(within(page).getByTestId('step-pane')).toBeInTheDocument()
      // No chip carries `aria-pressed` off the Summary — the selected item is
      // the route now.
      expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/greet/1`)
      expect(router.state.location.search).toBe('?step=greet%2F1%2Fsay')
    })

    it('opens the job card on Output from the right dot, and on Input from the left dot', async () => {
      const page = await openRun()

      fireEvent.click(within(page).getByRole('button', { name: 'Output of A slow server job' }))
      let io = within(page).getByTestId('job-io')
      // An edge dot opens the disclosure on the side it asked for.
      expect(io).toHaveAttribute('open')
      expect(within(io).getByRole('tab', { name: 'Output' })).toHaveAttribute('aria-selected', 'true')
      expect(within(io).getByRole('heading', { name: 'Hello report' })).toBeInTheDocument()

      // The second dot is on the graph too — back to the Summary for it, on
      // the job head's own crumb.
      fireEvent.click(within(within(page).getByTestId('job-head')).getByRole('button', { name: 'Run' }))
      fireEvent.click(within(page).getByRole('button', { name: 'Input of Confirm the report' }))
      io = within(page).getByTestId('job-io')
      expect(io).toHaveAttribute('open')
      expect(within(io).getByRole('tab', { name: 'Input' })).toHaveAttribute('aria-selected', 'true')
      // `needs: [slow, flaky]` — what the job waited on.
      expect(within(io).getByText('slow')).toBeInTheDocument()
      expect(within(io).getByText('flaky')).toBeInTheDocument()
    })

    it('opens the job a bare `?step=<job>` deep link names', async () => {
      seedFinishedRun()
      renderApp(`${RUN_PATH}?step=confirm`)
      const page = screen.getByRole('main')
      await within(page).findByTestId('run-status')
      // The shell's own redirect (round 1) commits a render after `run-status`
      // does — `find*` waits for it instead of racing it.
      expect(await within(page).findByTestId('job-page')).toBeInTheDocument()
    })

    it('opens the step a `?step=` deep link names', async () => {
      seedFinishedRun()
      const router = createMemoryRouter(createRoutesFromElements(routes), {
        initialEntries: [`${RUN_PATH}?step=flaky/0/boom`],
      })
      render(
        <Provider store={makeStore()}>
          <RouterProvider router={router} />
        </Provider>,
      )
      const page = screen.getByRole('main')
      await within(page).findByTestId('run-status')

      expect(await within(page).findByTestId('step-pane')).toBeInTheDocument()
      // The chip's `aria-pressed` no longer applies — the redirect landed the
      // URL on the step itself.
      expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/flaky/0`)
      expect(router.state.location.search).toBe('?step=flaky%2F0%2Fboom')
      expect(within(page).queryByTestId('run-pane')).not.toBeInTheDocument()
    })
  })

  it('groups the step summaries under their job, in scheduling order', async () => {
    const page = await openRun()

    const summary = within(page).getByTestId('run-summary')
    // Only `greet`'s two items write a summary in the fixture — one entry
    // (and heading) per item, each naming the job (and, being a matrix job,
    // its item too).
    const entries = within(summary).getAllByRole('article')
    expect(entries.map((e) => within(e).getByRole('heading').textContent)).toEqual([
      'Greet each name (who: world) summary',
      'Greet each name (who: studio) summary',
    ])
    expect(summary.textContent).toContain('Said')
    expect([...summary.querySelectorAll('strong')].map((el) => el.textContent)).toEqual([
      'Hello, world!',
      'Hello, studio!',
    ])
  })

  it('jumps to the step an annotation came from', async () => {
    const { page, router } = await openRunRouter()

    const annotations = within(page).getByTestId('annotations')
    // Closed by default (no error-level annotation on this run) — jsdom
    // doesn't hide a closed `<details>`'s content from queries the way a
    // real browser does, so its list is still reachable without opening it.
    expect(within(annotations).getByText('Job job_hello_1 took 1234 ms')).toBeInTheDocument()
    expect(within(annotations).getByText('boom failed with TEAPOT')).toBeInTheDocument()

    fireEvent.click(within(annotations).getByRole('link', { name: 'slow/0/start' }))

    // The link's own href, not a chip's `aria-pressed` — the jump is a
    // navigation to the step now.
    expect(router.state.location.pathname).toBe(`/hello/hello/runs/${FIXTURE_RUN_ID}/job/slow/0`)
    expect(router.state.location.search).toBe('?step=slow%2F0%2Fstart')
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

  it('still shows the record when a `?step=` names a step of a definition there is none of', async () => {
    // Fix round 1, finding 1: everything the shell derives from a parsed
    // `?step=` — the fullscreen strip's job and step labels — has to survive
    // the one path where there is no definition to look them up in.
    db.runs.set('run_bare', {
      ...FINISHED_RUN.run,
      runId: 'run_bare',
      definition: null,
      yaml: '',
      _id: nextId(),
    })

    renderApp('/hello/hello/runs/run_bare?step=slow%2F0%2Fstart')

    const page = screen.getByRole('main')
    expect(await within(page).findByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')
    expect(within(page).getByText(/read-only record/i)).toBeInTheDocument()
  })

  /**
   * The resume banner (05 leases): a running run this tab is not driving. The
   * lease decides the branch — held by a live tab offers *Take over*, expired
   * offers *Resume* — and each branch's copy says where Cancel will be once
   * the lease is taken: the run header, not the banner (apps#474). Both
   * strings only exist once the lease check has settled (a microtask), hence
   * `findBy*`.
   */
  describe('the resume banner', () => {
    /** The fixture run rewound to in-flight, under one lease or none. */
    function seedRunningRun(runId: string, lease: Pick<ServerRunRow, 'leaseOwner' | 'leaseUntil'>) {
      db.runs.set(runId, {
        ...FINISHED_RUN.run,
        runId,
        status: 'running',
        finishedAt: null,
        ...lease,
        _id: nextId(),
      })
      for (const step of FINISHED_RUN.steps) {
        db.steps.set(stepRowKey(runId, step.key), { ...step, runId, _id: nextId() })
      }
    }

    it('offers Take over on a run another tab holds, and says Cancel comes from the header afterwards', async () => {
      seedRunningRun('run_held', { leaseOwner: 'tab_other', leaseUntil: Date.now() + 60_000 })

      renderApp('/hello/hello/runs/run_held')

      const page = screen.getByRole('main')
      expect(await within(page).findByTestId('run-status')).toHaveAttribute('data-state', 'running')
      const takeOver = await within(page).findByTestId('run-take-over')
      const banner = takeOver.closest('p') as HTMLElement
      expect(banner).toHaveTextContent(
        'Another tab is driving this run. Take over to drive it — you can cancel it from the run header afterwards.',
      )
      expect(banner).not.toHaveTextContent('nobody is driving it')
      expect(within(page).queryByTestId('run-resume')).not.toBeInTheDocument()
      // Cancel is not in the banner: it lives in the header once the lease is ours.
      expect(within(banner).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
      expect(within(page).queryByTestId('run-cancel')).not.toBeInTheDocument()
    })

    it('offers Resume on a run nobody holds, with the same pointer to the header', async () => {
      seedRunningRun('run_free', { leaseOwner: null, leaseUntil: null })

      renderApp('/hello/hello/runs/run_free')

      const page = screen.getByRole('main')
      expect(await within(page).findByTestId('run-status')).toHaveAttribute('data-state', 'running')
      const resume = await within(page).findByTestId('run-resume')
      const banner = resume.closest('p') as HTMLElement
      expect(banner).toHaveTextContent(
        'This run is still in flight and nobody is driving it. Resume to take over — you can cancel it from the run header afterwards.',
      )
      expect(banner).not.toHaveTextContent('Another tab is driving this run')
      expect(within(page).queryByTestId('run-take-over')).not.toBeInTheDocument()
      expect(within(banner).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    })

    /**
     * The observer's convergence path (2026-08-31,
     * run_01M1CPTN6P47DXQDEABE8K9H8Y): a page that loaded a run mid-seal —
     * the row still `running` under another tab's live lease — keeps polling
     * (RunShell's 5 s `pollingInterval`), and the moment a poll reads the
     * sealed row the banner goes, the pill flips and the outputs render.
     * The app was never the stuck half of that walk (the seal itself was);
     * this pins the half that must keep working.
     */
    it('converges to the sealed record once a poll reads it — banner gone, outputs shown', async () => {
      seedRunningRun('run_sealing', { leaseOwner: 'tab_other', leaseUntil: Date.now() + 60_000 })

      renderApp('/hello/hello/runs/run_sealing')

      const page = screen.getByRole('main')
      expect(await within(page).findByTestId('run-status')).toHaveAttribute('data-state', 'running')
      await within(page).findByTestId('run-take-over')

      // The seal lands server-side between two polls.
      db.runs.set('run_sealing', { ...FINISHED_RUN.run, runId: 'run_sealing', _id: nextId() })

      // The next 5 s poll reads the sealed row (real timers — one poll tick).
      await waitFor(
        () => expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded'),
        { timeout: 8_000 },
      )
      expect(within(page).queryByTestId('run-take-over')).not.toBeInTheDocument()
      expect(within(page).getByTestId('run-outputs')).toBeInTheDocument()
    }, 15_000)
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

  /**
   * Fork — "Re-run from this job" (05; apps#491). The job card offers it only
   * where the client-side question says yes (`forkTarget`: a terminal run,
   * every job outside the pick's downstream closure `success`/`skipped`), never
   * on the run this tab drives, and only once the alias's *current* workflow
   * has loaded — the fork runs under that definition, not the parent's snapshot.
   * The fixture's forkability at `slow` is proved in `finishedRun.test.ts`; this
   * suite proves the page turns that answer into the button, one call to the
   * fork rule, and a navigation to the new run.
   */
  describe('forking a run ("Re-run from this job")', () => {
    const asOwner = () =>
      setMockUser({ id: 'user_fixture', email: 'fixture@example.test', role: 'user' })

    /** Where the router is, read off the DOM: the fork's navigation is the assertion. */
    function Location() {
      return <span data-testid="location">{useLocation().pathname}</span>
    }

    function renderAt(path: string) {
      const store = makeStore()
      render(
        <Provider store={store}>
          <MemoryRouter initialEntries={[path]}>
            <App />
            <Location />
          </MemoryRouter>
        </Provider>,
      )
      return store
    }

    /**
     * The alias's current workflow has arrived: the fork runs under it, so
     * the button waits for it, and a "no button" assertion made before it is
     * here would pass for the wrong reason. Read off the query cache the page
     * itself reads, so this is the very fact the page's gate waits on.
     */
    const currentWorkflowLoaded = (store: ReturnType<typeof makeStore>) =>
      waitFor(() =>
        expect(
          workflowApi.endpoints.getWorkflowYaml.select({ impl: 'hello', file: 'hello.workflow.yaml' })(
            store.getState(),
          ).data,
        ).toBeDefined(),
      )

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('offers the fork on the job card of a forkable job of a finished run', async () => {
      asOwner()
      seedFinishedRun()
      renderAt(`${RUN_PATH}?step=slow`)
      const page = screen.getByRole('main')

      const head = await within(page).findByTestId('job-head')
      // The current workflow arrives through discovery; the button waits for it.
      expect(await within(head).findByTestId('job-fork')).toHaveTextContent('Re-run from this job')
    })

    it('offers none on a job whose upstream failed, and still offers it on the job to pick instead', async () => {
      asOwner()
      seedFinishedRun()
      // `greet` failed, so `slow` (needs greet) cannot be the pick; `greet` itself still can.
      const say = db.steps.get(stepRowKey(FIXTURE_RUN_ID, 'greet/0/say'))!
      db.steps.set(stepRowKey(FIXTURE_RUN_ID, 'greet/0/say'), { ...say, status: 'failed' })
      renderAt(`${RUN_PATH}?step=greet`)
      const page = screen.getByRole('main')

      // The button on `greet` is the proof the current workflow has loaded …
      let head = await within(page).findByTestId('job-head')
      expect(await within(head).findByTestId('job-fork')).toBeInTheDocument()

      // … so its absence on `slow`, opened from the graph's own node, is the
      // gate's answer. The node is on the Summary now — back there first, on
      // the job head's own crumb.
      fireEvent.click(within(head).getByRole('button', { name: 'Run' }))
      fireEvent.click(node('slow')!)
      head = within(page).getByTestId('job-head')
      expect(within(head).getByRole('heading', { name: 'A slow server job' })).toBeInTheDocument()
      expect(within(head).queryByTestId('job-fork')).not.toBeInTheDocument()
    })

    it('offers none while the run is still running', async () => {
      asOwner()
      seedFinishedRun()
      db.runs.set(FIXTURE_RUN_ID, { ...db.runs.get(FIXTURE_RUN_ID)!, status: 'running', finishedAt: null })
      const store = renderAt(`${RUN_PATH}?step=greet`)
      const page = screen.getByRole('main')

      const head = await within(page).findByTestId('job-head')
      await currentWorkflowLoaded(store)
      expect(within(head).queryByTestId('job-fork')).not.toBeInTheDocument()
    })

    it('forks the run at the job with one call to the rule, and lands on the new run', async () => {
      asOwner()
      seedFinishedRun()
      const forkCalls: string[] = []
      const onRequestStart = ({ request }: { request: Request }) => {
        if (request.method === 'POST' && new URL(request.url).pathname === '/api/workflow/run/fork') {
          forkCalls.push(request.url)
        }
      }
      server.events.on('request:start', onRequestStart)
      const store = renderAt(`${RUN_PATH}?step=slow`)
      try {
        const page = screen.getByRole('main')
        const jobHead = await within(page).findByTestId('job-head')

        fireEvent.click(await within(jobHead).findByTestId('job-fork'))

        // The rule wrote a second run row, under a new id …
        await waitFor(() => expect(db.runs.size).toBe(2))
        const forkId = [...db.runs.keys()].find((id) => id !== FIXTURE_RUN_ID)!
        expect(forkId).toMatch(/^run_/)
        expect(db.runs.get(forkId)).toMatchObject({ forkedFrom: FIXTURE_RUN_ID, forkJob: 'slow' })
        // … the page navigated to it, on the run's own page (no `?step=` carried over) …
        await waitFor(() =>
          expect(screen.getByTestId('location')).toHaveTextContent(`/hello/hello/runs/${forkId}`),
        )
        // … and this tab is now driving it, so the header reads it live
        // (scoped to the header: the run card under the graph names the run too).
        expect(store.getState().run.state?.runId).toBe(forkId)
        const head = page.querySelector('.run-head') as HTMLElement
        expect(await within(head).findByText(forkId)).toBeInTheDocument()
        expect(within(head).getByTestId('run-status')).toHaveAttribute('data-state', 'running')
        // … naming its parent right away, not only once it is reopened as a
        // replay: the adopt path carries the row's `forkedFrom` on `RunMeta` (apps#513).
        const forkedFrom = within(head).getByTestId('run-forked-from')
        expect(forkedFrom).toHaveTextContent(`forked from ${FIXTURE_RUN_ID} at slow`)
        expect(within(forkedFrom).getByRole('link', { name: FIXTURE_RUN_ID })).toHaveAttribute(
          'href',
          `/hello/hello/runs/${FIXTURE_RUN_ID}`,
        )
        expect(within(page).queryByTestId('run-fork-failed')).not.toBeInTheDocument()
        expect(forkCalls).toHaveLength(1)
      } finally {
        server.events.removeListener('request:start', onRequestStart)
        store.dispatch(runClosed())
      }
    })

    it("stays on the run and shows the rule's own reason when the server refuses", async () => {
      asOwner()
      seedFinishedRun()
      server.use(
        http.post('/api/workflow/run/fork', () =>
          HttpResponse.json({ ok: false, error: 'only the run owner or an admin can fork a run' }, { status: 403 }),
        ),
      )
      renderAt(`${RUN_PATH}?step=slow`)
      const page = screen.getByRole('main')
      const head = await within(page).findByTestId('job-head')

      fireEvent.click(await within(head).findByTestId('job-fork'))

      const failed = await within(page).findByTestId('run-fork-failed')
      expect(failed).toHaveTextContent('only the run owner or an admin can fork a run')
      expect(screen.getByTestId('location')).toHaveTextContent(`/hello/hello/runs/${FIXTURE_RUN_ID}`)
      expect(db.runs.size).toBe(1)
      // The card is still there with its button: a refusal is an outcome, not a dead end.
      expect(within(page).getByTestId('job-fork')).toBeInTheDocument()
    })
  })
})
