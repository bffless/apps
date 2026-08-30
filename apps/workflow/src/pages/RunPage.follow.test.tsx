/**
 * Follow or pinned (apps#452).
 *
 * The run page's selection starts out **following** the run — a waiting form
 * opens as its pane, a loading island claims it once, a finished run returns
 * to the run card — and stops the moment the person picks a step: from then
 * on nothing moves it but them, and the header's "Follow run" toggle is the
 * way back. What must keep happening while pinned is the run itself: an
 * island driving itself (07 unattended / `auto-accept`) is mounted
 * **backstage**, out of sight, rather than by taking the pane.
 *
 * `GET /api/workflow/run` is stubbed to "nothing here" throughout: every run
 * below is driven by this tab, off the slice.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { http, HttpResponse } from 'msw'
import { Provider } from 'react-redux'
import {
  MemoryRouter,
  createMemoryRouter,
  createRoutesFromElements,
  RouterProvider,
} from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from '../App'
import type { Definition, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import { server } from '../mocks/server'
import { routes } from '../routes'
import type { AppStore } from '../store'
import { startRun } from '../store/runnerActions'
import { REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting } from '../test/helloHarness'
import { islandStore, pumpUntil, resetIslandHarness } from '../test/islandHarness'

/** A finished pipeline step of `hello`, there to be pinned on. */
const START_KEY: StepKey = 'slow/0/start'

beforeEach(() => {
  server.use(http.get('/api/workflow/run', () => HttpResponse.json({ run: null, steps: [] })))
})

afterEach(() => {
  resetHelloHarness()
  resetIslandHarness()
})

function chip(page: HTMLElement, key: string): HTMLElement | null {
  return (
    within(page)
      .getAllByTestId('step')
      .find((el) => el.getAttribute('data-key') === key) ?? null
  )
}

function renderAt(store: AppStore, url: string) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[url]}>
        <App />
      </MemoryRouter>
    </Provider>,
  )
}

// ---------------------------------------------------------------------------
// Mode transitions, on `hello` held at its waiting form
// ---------------------------------------------------------------------------

describe('RunPage — follow mode', () => {
  it('follows on a fresh load with no `?step=`: the waiting form opens, and the toggle reads on', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    renderAt(store, `/hello/hello/runs/${runId}`)
    const page = screen.getByRole('main')

    expect(await within(page).findByRole('button', { name: 'Finish' })).toBeInTheDocument()
    expect(store.getState().ui.selectedStep).toBe(REVIEW_KEY)
    const toggle = within(page).getByTestId('run-follow')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('data-state', 'on')
    expect(store.getState().ui.follow).toEqual({ runId, on: true })
  })

  it('is pinned by a `?step=` deep link: the waiting form does not open over it, and the toggle reads off', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    renderAt(store, `/hello/hello/runs/${runId}?step=${START_KEY}`)
    const page = screen.getByRole('main')

    await within(page).findByTestId('step-pane')
    expect(chip(page, START_KEY)).toHaveAttribute('aria-pressed', 'true')
    expect(within(page).queryByRole('button', { name: 'Finish' })).not.toBeInTheDocument()
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'off')
    expect(store.getState().ui.follow).toEqual({ runId, on: false })
  })

  it('pins on a chip click, and Follow brings the selection back to the step the run is at', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    renderAt(store, `/hello/hello/runs/${runId}`)
    const page = screen.getByRole('main')
    await within(page).findByRole('button', { name: 'Finish' })

    // The person picks a finished step: the form's pane gives way, and stays away.
    fireEvent.click(chip(page, START_KEY)!)
    expect(store.getState().ui.selectedStep).toBe(START_KEY)
    expect(within(page).queryByRole('button', { name: 'Finish' })).not.toBeInTheDocument()
    const toggle = within(page).getByTestId('run-follow')
    expect(toggle).toHaveAttribute('data-state', 'off')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.getState().ui.selectedStep).toBe(START_KEY)

    // Follow again: the page catches up to the waiting form on its own rules.
    fireEvent.click(toggle)
    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(REVIEW_KEY))
    expect(within(page).getByRole('button', { name: 'Finish' })).toBeInTheDocument()
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'on')
  })

  it('pins on the pane’s crumbs, the way up a level', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    renderAt(store, `/hello/hello/runs/${runId}`)
    const page = screen.getByRole('main')
    await within(page).findByRole('button', { name: 'Finish' })

    // The job crumb climbs out of the form to its job — a person's move.
    fireEvent.click(within(page).getByTestId('step-pane-back'))
    expect(store.getState().ui.selectedStep).toBe('confirm')
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'off')
    // …and the form is not re-opened over the job card.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.getState().ui.selectedStep).toBe('confirm')
    expect(within(page).queryByRole('button', { name: 'Finish' })).not.toBeInTheDocument()
  })

  it('turns following off in place: the toggle pins whatever is selected', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    renderAt(store, `/hello/hello/runs/${runId}`)
    const page = screen.getByRole('main')
    await within(page).findByRole('button', { name: 'Finish' })

    fireEvent.click(within(page).getByTestId('run-follow'))
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'off')
    expect(store.getState().ui.selectedStep).toBe(REVIEW_KEY)
    expect(within(page).getByRole('button', { name: 'Finish' })).toBeInTheDocument()
  })

  it('pins on a `?step=` the person navigated to — typed, or stepped Back to', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    const router = createMemoryRouter(createRoutesFromElements(routes), {
      initialEntries: [`/hello/hello/runs/${runId}`],
    })
    render(
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>,
    )
    const page = screen.getByRole('main')
    await within(page).findByRole('button', { name: 'Finish' })
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'on')

    await act(async () => {
      await router.navigate(`/hello/hello/runs/${runId}?step=${START_KEY}`)
    })

    await waitFor(() =>
      expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'off'),
    )
    expect(store.getState().ui.selectedStep).toBe(START_KEY)
    expect(within(page).queryByRole('button', { name: 'Finish' })).not.toBeInTheDocument()
  })

  it('returns to the run card when the run finishes while following, and offers no toggle on a finished run', async () => {
    const { store, runId } = await startHelloAtConfirmWaiting()
    renderAt(store, `/hello/hello/runs/${runId}`)
    const page = screen.getByRole('main')

    fireEvent.click(await within(page).findByRole('button', { name: 'Finish' }))

    await waitFor(() => {
      expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')
    })
    await waitFor(() => expect(store.getState().ui.selectedStep).toBeNull())
    expect(within(page).queryByTestId('run-follow')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Unattended while pinned: the run keeps moving, the pane does not
// ---------------------------------------------------------------------------

const SCENES_YAML = 'name: Scenes\n'

/** A scene that drives itself (07: `headless: auto`) once told to. */
const scene = (id: string) => ({
  id,
  uses: 'island',
  with: { src: `islands/${id}.html`, title: id, mode: 'quick' },
  outputs: { choice: { type: 'string' } },
  headless: 'auto',
})

/**
 * A director's brief (a form that answers itself unattended, so the run gets
 * past it), then three self-submitting scenes in a row.
 */
const SCENES_DEF = toDefinition({
  name: 'Scenes',
  jobs: {
    director: {
      steps: [
        {
          id: 'brief',
          uses: 'form',
          with: { title: 'Brief', fields: { note: { type: 'string', default: 'go' } }, submit: 'Go' },
          headless: 'auto',
        },
      ],
    },
    scenes: { needs: 'director', steps: [scene('scene1'), scene('scene2'), scene('scene3')] },
  },
}) as Definition

const DIRECTOR_KEY: StepKey = stepKey('director', 0, 'brief')
const SCENE_KEYS: StepKey[] = ['scene1', 'scene2', 'scene3'].map((id) => stepKey('scenes', 0, id))

describe('RunPage — unattended while pinned', () => {
  it('completes three self-driving scenes backstage while the person stays pinned on Director', async () => {
    const { store, advance, host } = islandStore()
    store.dispatch(
      startRun({
        impl: 'test',
        workflow: 'scenes',
        def: SCENES_DEF,
        yaml: SCENES_YAML,
        workflowName: 'Scenes',
        values: {},
        unattended: true,
      }),
    )
    await pumpUntil(
      advance,
      () => store.getState().run.state?.steps[SCENE_KEYS[0]!]?.status === 'running',
    )
    const runId = store.getState().run.state!.runId
    expect(store.getState().run.state!.steps[DIRECTOR_KEY].status).toBe('succeeded')

    renderAt(store, `/test/scenes/runs/${runId}`)
    const page = screen.getByRole('main')

    // Following: the loading first scene claims the pane, as it always did.
    await waitFor(() => expect(store.getState().ui.selectedStep).toBe(SCENE_KEYS[0]))
    await waitFor(() => expect(host.mounts).toHaveLength(1))
    expect(within(page).getByTestId('step-pane')).toContainElement(screen.getByTestId('island-frame'))

    // The person pins the finished Director step.
    fireEvent.click(chip(page, DIRECTOR_KEY)!)
    expect(store.getState().ui.selectedStep).toBe(DIRECTOR_KEY)
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'off')

    const paneShowsDirector = () => {
      const pane = within(page).getByTestId('step-pane')
      expect(pane).toHaveTextContent(DIRECTOR_KEY)
      expect(within(pane).queryByTestId('island-frame')).toBeNull()
      expect(store.getState().ui.selectedStep).toBe(DIRECTOR_KEY)
    }

    // Each scene in turn mounts backstage — out of the pane, in the document —
    // reaches `waiting`, submits by itself, and the next one takes its place.
    for (const [i, key] of SCENE_KEYS.entries()) {
      await waitFor(() =>
        expect(store.getState().run.state!.steps[key]?.status).toBe('running'),
      )
      const backstage = await within(page).findByTestId('island-backstage')
      await waitFor(() => expect(host.pending()).toBe(1))
      expect(within(backstage).getByTestId('island-frame')).toBeInTheDocument()
      expect(host.mounts.at(-1)!.headless).toBe(true)
      paneShowsDirector()

      host.settle()
      await waitFor(() => expect(store.getState().run.state!.steps[key].status).toBe('waiting'))
      paneShowsDirector()

      expect(host.allDeps[i]!.onSubmit({ choice: `take ${i + 1}` })).toEqual({ ok: true })
      await waitFor(() => expect(store.getState().run.state!.steps[key].status).toBe('succeeded'))
      paneShowsDirector()
    }

    // All three done, the run finished — and the pane never left Director,
    // not even for the finished run's return to the run card.
    await waitFor(() => {
      expect(within(page).getByTestId('run-status')).toHaveAttribute('data-state', 'succeeded')
    })
    expect(store.getState().run.state!.outputs).toBeDefined()
    paneShowsDirector()
    expect(within(page).queryByTestId('island-backstage')).not.toBeInTheDocument()
  })

  it('also mounts a self-driving island backstage while following, when a form being filled in owns the pane', async () => {
    // The parallel case the claim-once rule refuses to act on: a person
    // mid-form outranks a loading island (fix round 4). Unattended, that
    // island now still gets to run — just not in the pane.
    const def = toDefinition({
      name: 'Scenes',
      jobs: {
        ask: {
          steps: [
            {
              id: 'confirm',
              uses: 'form',
              with: {
                title: 'Does this look right?',
                fields: { approved: { type: 'boolean', default: true } },
                submit: 'Finish',
              },
            },
          ],
        },
        scenes: { steps: [scene('scene1')] },
      },
    }) as Definition
    const FORM_KEY = stepKey('ask', 0, 'confirm')
    const { store, advance, host } = islandStore()
    store.dispatch(
      startRun({
        impl: 'test',
        workflow: 'scenes',
        def,
        yaml: SCENES_YAML,
        workflowName: 'Scenes',
        values: {},
        unattended: true,
      }),
    )
    await pumpUntil(
      advance,
      () => store.getState().run.state?.steps[SCENE_KEYS[0]!]?.status === 'running',
    )
    const runId = store.getState().run.state!.runId

    renderAt(store, `/test/scenes/runs/${runId}`)
    const page = screen.getByRole('main')

    // The undeclared form waits for its person and takes the pane; following stays on.
    await waitFor(() => expect(within(page).getByTestId('form-step')).toBeInTheDocument())
    expect(store.getState().ui.selectedStep).toBe(FORM_KEY)
    expect(within(page).getByTestId('run-follow')).toHaveAttribute('data-state', 'on')

    const backstage = await within(page).findByTestId('island-backstage')
    await waitFor(() => expect(host.pending()).toBe(1))
    expect(within(backstage).getByTestId('island-frame')).toBeInTheDocument()
    host.settle()
    await waitFor(() =>
      expect(store.getState().run.state!.steps[SCENE_KEYS[0]!].status).toBe('waiting'),
    )
    expect(host.allDeps[0]!.onSubmit({ choice: 'take 1' })).toEqual({ ok: true })
    await waitFor(() =>
      expect(store.getState().run.state!.steps[SCENE_KEYS[0]!].status).toBe('succeeded'),
    )
    // The form was never disturbed.
    expect(store.getState().ui.selectedStep).toBe(FORM_KEY)
    expect(within(page).getByTestId('form-step')).toBeInTheDocument()
  })
})
