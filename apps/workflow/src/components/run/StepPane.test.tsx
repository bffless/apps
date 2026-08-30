/**
 * Fix round 1, finding 2: `StepPane`'s `waiting`-form delegation to
 * `FormStepPane` must only fire for the run this tab is actually driving
 * (`live`). A read-only replay of a waiting form step — another tab's
 * in-flight run, or a run this tab used to drive and has since navigated
 * away from — must fall back to the ordinary tabbed view instead: `runEvent`
 * carries no `runId`, so a submit from a read-only pane would land on
 * whatever run the *global* `runSlice` currently holds live, silently
 * mutating an unrelated run that happens to share the step key (near-certain
 * for two runs of the same workflow, since step keys are `<job>/<index>/
 * <step>` with no run component at all).
 *
 * Both tests share one store whose *live* run is `hello`'s own
 * `confirm/0/review` waiting (Task 17/18's harness) — proving the read-only
 * case falls back to tabs even while a same-keyed run really is live in that
 * very store, and the live case still gets the form.
 */
import { http, HttpResponse } from 'msw'
import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StepPane } from './StepPane'
import { resetShowRaw } from '../values/rawPreference'
import { hello, REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting } from '../../test/helloHarness'
import { server } from '../../mocks/server'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { RENDERED_RUN } from '../../mocks/fixtures/renderedRun'
import { replayRun } from '../../lib/runner/replay'
import type { RunState, StepState } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'
import { makeStore } from '../../store'
import { BUNDLE_KEY, FRAME_URL, REVIEW_KEY as FRAMES_REVIEW_KEY, FRAMES_DEF, framesRun } from '../../test/framesRun'

// jsdom has no canvas (`ChartView.test.tsx` explains why); this file only
// needs to know `render: chart` reaches `ChartView`, not that uPlot can
// actually draw into a headless DOM — hence the shared inert stub.
vi.mock('uplot', async () => (await import('../../test/uplotMock')).inertUPlot())

afterEach(() => {
  resetHelloHarness()
})

function stepState(job: string, index: number, stepId: string, over: Partial<StepState> = {}): StepState {
  return {
    key: stepKey(job, index, stepId),
    job,
    index,
    stepId,
    kind: 'pipeline',
    status: 'queued',
    attempt: 1,
    annotations: [],
    ...over,
  }
}

/** A *different* run's replayed state — same workflow, same step key, waiting on the same form. */
function readonlyConfirmWaiting(): RunState {
  return {
    runId: 'run_OTHER_READONLY',
    impl: 'hello',
    workflow: 'hello',
    status: 'running',
    headless: false,
    unattended: false,
    inputs: { greeting: 'Hello', names: ['world'], photo: null, shout: false },
    steps: {
      [stepKey('slow', 0, 'start')]: stepState('slow', 0, 'start', {
        status: 'succeeded',
        outputs: { report: '# r', poster: null },
      }),
      [REVIEW_KEY]: stepState('confirm', 0, 'review', { kind: 'form', status: 'waiting' }),
    },
    expansions: { greet: { total: 1, items: [{ who: 'world' }] } },
    annotations: [],
    startedAt: 1_000,
  }
}

describe('StepPane — live gates the waiting-form delegation', () => {
  it('falls back to the tabbed view for a read-only replay, even while a same-keyed run is live in this store', async () => {
    // A genuinely live run occupies the store's run slice throughout.
    const { store } = await startHelloAtConfirmWaiting()

    render(
      <Provider store={store}>
        <StepPane def={hello} state={readonlyConfirmWaiting()} stepKey={REVIEW_KEY} live={false} />
      </Provider>,
    )

    expect(screen.queryByRole('button', { name: 'Finish' })).not.toBeInTheDocument()
    expect(screen.getByTestId('step-pane')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Input' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))
    expect(screen.getByText('Attempt 1')).toBeInTheDocument()
  })

  it('still delegates to FormStepPane for the run this tab is driving (live)', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const state = store.getState().run.state!

    render(
      <Provider store={store}>
        <StepPane def={hello} state={state} stepKey={REVIEW_KEY} live />
      </Provider>,
    )

    expect(screen.getByLabelText(/^approved/)).toBeChecked()
    expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument()
  })
})

/**
 * Task 17's renderer sweep, one level down from `RunOutputs`: the same five
 * named renderers have to reach the Output tab too, off the very same
 * replayed step row — including `island`, which needs `impl` threaded from
 * `state.impl` rather than only from `ImplContext`. A bare `Provider` is
 * enough here (Task 22): the Output tab's hover wiring needs a dispatch to
 * render at all, but this test never hovers, so a fresh store with no live
 * run is fine.
 */
/**
 * apps#437: a File ref among a step's evaluated inputs is a file card, and an
 * `image/*` one draws the image — the same `FileCard` the Output side uses,
 * off the ref's own same-origin `url` (no presigning: this page sends the
 * cookie the serve route wants, unlike an island's opaque-origin frame). The
 * step is read-only here on purpose: the Input tab is the ordinary tabbed
 * view, not the live form.
 */
describe('StepPane — Input tab previews an image File ref (apps#437)', () => {
  it('draws the image beside its name for an image/* ref in the step inputs', () => {
    const photo = {
      path: 'workflows/hello/hello/inputs/1/me.jpg',
      name: 'me.jpg',
      contentType: 'image/jpeg',
      size: 5,
      url: '/api/uploads/workflows/hello/hello/inputs/1/me.jpg',
    }
    const state = readonlyConfirmWaiting()
    const key = stepKey('slow', 0, 'start')
    state.steps[key] = stepState('slow', 0, 'start', {
      status: 'succeeded',
      inputs: { photo },
      outputs: { report: '# r', poster: null },
    })

    const { container } = render(
      <Provider store={makeStore()}>
        <StepPane def={hello} state={state} stepKey={key} live={false} />
      </Provider>,
    )

    expect(screen.getByRole('tab', { name: 'Input' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('photo')).toBeInTheDocument()
    expect(container.querySelector('.file-card img')?.getAttribute('src')).toBe(photo.url)
    expect(screen.getByText('me.jpg')).toBeInTheDocument()
  })

  // apps#451: the recording just confirmed on the kickoff form is the same
  // playable, scrubbable card once the run has started.
  it('draws a playable card for a video/* ref in the step inputs', () => {
    const take = {
      path: 'workflows/hello/hello/inputs/1/take-1.mp4',
      name: 'take-1.mp4',
      contentType: 'video/mp4',
      size: 2048,
      url: '/api/uploads/workflows/hello/hello/inputs/1/take-1.mp4',
    }
    const state = readonlyConfirmWaiting()
    const key = stepKey('slow', 0, 'start')
    state.steps[key] = stepState('slow', 0, 'start', {
      status: 'succeeded',
      inputs: { take },
      outputs: { report: '# r', poster: null },
    })

    const { container } = render(
      <Provider store={makeStore()}>
        <StepPane def={hello} state={state} stepKey={key} live={false} />
      </Provider>,
    )

    const video = container.querySelector('.file-card video')
    expect(video?.getAttribute('src')).toBe(take.url)
    expect(video).toHaveAttribute('controls')
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(video).not.toHaveAttribute('autoplay')
    expect(screen.getByText('take-1.mp4')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `${take.url}?download=1`)
  })
})

describe('StepPane — Output tab renders every named renderer', () => {
  it('shows all five renderer wrappers for the rendered-run fixture step', () => {
    server.use(
      http.get('/w/hello/islands/line-viewer.html', () =>
        HttpResponse.text('<!doctype html><p>viewer</p>'),
      ),
    )

    const def = toDefinition(RENDERED_RUN.run.definition)
    const state = replayRun(RENDERED_RUN.run, RENDERED_RUN.steps, def)

    render(
      <Provider store={makeStore()}>
        <StepPane def={def} state={state} stepKey="show/0/render" live={false} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))

    const renderers = screen.getAllByTestId('renderer')
    expect(renderers.map((el) => el.getAttribute('data-render')).sort()).toEqual(
      ['chart', 'code', 'images', 'island', 'transcript'].sort(),
    )
    expect(screen.queryAllByText(/^renderer:/)).toHaveLength(0)
  })
})

/**
 * Task 22: the Output tab is the hover source the graph's data-flow highlight
 * reads — each output's `ValueView` is given the step's own identity, so
 * hovering it dispatches exactly what a downstream reader's `needs`/`steps`
 * ref would match.
 */
describe('StepPane — Output tab hover dispatches the value under the pointer', () => {
  it("hovering an output sets ui.hoveredValue to this step's own identity, and clears on leave", () => {
    const def = toDefinition(FINISHED_RUN.run.definition)
    const state = replayRun(FINISHED_RUN.run, FINISHED_RUN.steps, def)
    const store = makeStore()

    render(
      <Provider store={store}>
        <StepPane def={def} state={state} stepKey="greet/0/say" live={false} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))
    const wrapper = screen.getByText('line').closest('.value')!

    fireEvent.mouseEnter(wrapper)
    expect(store.getState().ui.hoveredValue).toEqual({ job: 'greet', step: 'say', output: 'line' })

    fireEvent.mouseLeave(wrapper)
    expect(store.getState().ui.hoveredValue).toBeNull()
  })

  // Final review, finding 1: a hover left mid-flight when the Output tab goes
  // away (switching tabs, or — via `StepPane`'s `key={selectedStep}` — picking
  // a different step) must not survive the unmount. `onMouseLeave` never
  // fires for a DOM node that was removed out from under the cursor, so the
  // cleanup has to be the unmount itself, not the pointer.
  it('clears ui.hoveredValue when the Output tab unmounts (switching away without a mouseleave)', () => {
    const def = toDefinition(FINISHED_RUN.run.definition)
    const state = replayRun(FINISHED_RUN.run, FINISHED_RUN.steps, def)
    const store = makeStore()

    render(
      <Provider store={store}>
        <StepPane def={def} state={state} stepKey="greet/0/say" live={false} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))
    const wrapper = screen.getByText('line').closest('.value')!
    fireEvent.mouseEnter(wrapper)
    expect(store.getState().ui.hoveredValue).not.toBeNull()

    // Switch tabs without ever firing `mouseleave` on the hovered value.
    fireEvent.click(screen.getByRole('tab', { name: 'Input' }))
    expect(store.getState().ui.hoveredValue).toBeNull()
  })
})

/**
 * apps#446: a markdown output's `images` map (02) is evaluated off the run's
 * persisted rows and rewrites the post's placeholder tokens / zip-relative
 * paths to the harness's own serve route — so a finished (or replayed) run's
 * Output tab shows the frames the island showed while the step was waiting.
 */
describe('StepPane — Output tab draws a markdown output through its images map (apps#446)', () => {
  function outputTab(key: string) {
    const utils = render(
      <Provider store={makeStore()}>
        <StepPane def={FRAMES_DEF} state={framesRun()} stepKey={key} live={false} />
      </Provider>,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }))
    return utils
  }

  it("rewrites mapped frame: tokens from an earlier step's map; unmapped ones keep today's behaviour", () => {
    const { container } = outputTab(FRAMES_REVIEW_KEY)
    const views = container.querySelectorAll('.markdown-view')
    expect(views).toHaveLength(2)
    const [post, plain] = Array.from(views)

    const imgs = Array.from(post!.querySelectorAll('img')).map((img) => img.getAttribute('src'))
    expect(imgs).toEqual([FRAME_URL, 'images/a.jpg'])
    expect(post!.querySelector('.markdown-caption')?.textContent).toBe('The diff')
    expect(post!.textContent).toContain('Never captured')

    // The same markdown on an output with no `images` renders exactly as before.
    expect(Array.from(plain!.querySelectorAll('img')).map((img) => img.getAttribute('src'))).toEqual(['images/a.jpg'])
    expect(plain!.querySelector('.markdown-figure')).toBeNull()
  })

  it("rewrites zip-relative paths from the step's own srcs output", () => {
    const { container } = outputTab(BUNDLE_KEY)
    expect(container.querySelector('.markdown-view img')?.getAttribute('src')).toBe(FRAME_URL)
  })
})

// apps#450: a pipeline step's recorded `body` — a hundred floats under
// `times`, a storage path under `outPrefix` — reads as a compact list and a
// basename chip inside the tree, and the pane's Show raw flips the whole pane
// back to nodes and leaves.
describe('StepPane — Input tab draws shaped values, and Show raw flips them (apps#450)', () => {
  afterEach(() => {
    resetShowRaw()
  })

  it('draws body.times as a compact list and body.outPrefix as a path chip; Show raw makes them a tree', () => {
    const times = Array.from({ length: 120 }, (_, i) => i * 1.6816666)
    const outPrefix = 'workflows/hello/hello/runs/run_1/slow/0/start'
    const state = readonlyConfirmWaiting()
    const key = stepKey('slow', 0, 'start')
    state.steps[key] = stepState('slow', 0, 'start', {
      status: 'succeeded',
      inputs: { body: { source: 'x', outPrefix, times } },
      outputs: { report: '# r', poster: null },
    })

    const { container } = render(
      <Provider store={makeStore()}>
        <StepPane def={hello} state={state} stepKey={key} live={false} />
      </Provider>,
    )

    const list = screen.getByTestId('inline-list')
    expect(list.textContent).toContain('0, 1.68, 3.36')
    expect(list.textContent).toContain('(120)')
    expect(screen.getByRole('button', { name: 'show all 120 items' })).toBeInTheDocument()
    expect(screen.getByTestId('value-path')).toHaveAttribute('title', outPrefix)
    expect(screen.getByTestId('value-path').querySelector('.value-path-name')?.textContent).toBe('start')
    // The value-level flip is there: this `json` value holds shapes.
    expect(screen.getByTestId('value-raw')).toHaveTextContent('json')

    const toggle = screen.getByTestId('pane-raw')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('inline-list')).toBeNull()
    expect(screen.queryByTestId('value-path')).toBeNull()
    expect(container.querySelectorAll('.json-leaf').length).toBeGreaterThan(120)
    expect(screen.getByTestId('value-raw')).toHaveTextContent('rendered')
    expect(window.localStorage.getItem('workflow:show-raw')).toBe('1')
  })
})
