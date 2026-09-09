/**
 * The step row: the head's own reading of a step, and what the row expands
 * into.
 *
 * The `headless` badge and the data-flow stamp came here from the graph's step
 * chip (`StepChip.test.tsx`, retired with the chip): the badge is declared
 * mode only — spelled `headless: skip|auto`, never the bare `headless` label,
 * which used to read like a status rather than a declaration — and run mode
 * never shows it at all, because there it would be read as an attempt's
 * status rather than the step's own contract.
 *
 * The body half is the row's real job: an open row on the live path *is* the
 * waiting form (08: "the pane is the form"), a read-only replay of the same
 * step falls back to the tabs, and a step the run never reached cannot be
 * opened at all.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import interactiveYaml from '../../../docs/spec/examples/interactive.workflow.yaml?raw'
import { loadWorkflow } from '../../lib/runner/definition'
import { replayRun } from '../../lib/runner/replay'
import { stepsOfJob } from '../../lib/runner/jobs'
import type { JobStepRow } from '../../lib/runner/jobs'
import type { Definition, RunState, Step } from '../../lib/runner/types'
import { FINISHED_RUN } from '../../mocks/fixtures/finishedRun'
import { makeStore } from '../../store'
import { hello, resetHelloHarness, startHelloAtConfirmWaiting } from '../../test/helloHarness'
import { flowFor } from '../graph/flow'
import { StepRow } from './StepRow'

const interactive = loadWorkflow(interactiveYaml, 'interactive.workflow.yaml').def as Definition
const finished = replayRun(FINISHED_RUN.run, FINISHED_RUN.steps, hello)

const review = hello.jobs.confirm!.steps[0]! // `headless: { mode: skip, outputs: {...} }`
const say = hello.jobs.greet!.steps[0]! // no `headless` declared at all
const choose = interactive.jobs.pick!.steps[0]! // the bare `headless: auto` form
/** The bare `headless: skip` scalar (07) — no example workflow declares one. */
const bareSkip: Step = {
  id: 'ack',
  index: 0,
  uses: 'form',
  raw: { id: 'ack', uses: 'form', with: { title: 'OK?', fields: {} }, headless: 'skip' },
}

afterEach(() => {
  resetHelloHarness()
})

/** A row for a declared step nothing has run yet — `state` absent by construction. */
function declaredRow(step: Step, job: string): JobStepRow {
  return { key: `${job}/0/${step.id}`, step, index: 0, state: undefined }
}

function renderRow(
  props: Partial<Parameters<typeof StepRow>[0]> & { row: JobStepRow },
  state: RunState = finished,
  store = makeStore(),
) {
  return render(
    <Provider store={store}>
      <MemoryRouter>
        <ul>
          <StepRow def={hello} state={state} open={false} live={false} onToggle={vi.fn()} {...props} />
        </ul>
      </MemoryRouter>
    </Provider>,
  )
}

describe('StepRow — the head', () => {
  it("names the step, its kind and its attempt, and stamps the headless contract's attributes", () => {
    const row = stepsOfJob(hello, finished, 'slow', 0)[0]!
    renderRow({ row })

    const head = screen.getByTestId('step')
    expect(head).toHaveAttribute('data-key', 'slow/0/start')
    expect(head).toHaveAttribute('data-state', 'succeeded')
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toBeEnabled()
    expect(within(head).getByText('start')).toBeInTheDocument()
    expect(within(head).getByText('pipeline')).toBeInTheDocument()
    // The fixture's `slow/0/start` retried once, so the row says which try this is.
    expect(within(head).getByText('attempt 2')).toBeInTheDocument()
    expect(within(head).getByText('7.0 s')).toBeInTheDocument()
  })

  it('never opens a step the run has not reached', () => {
    const onToggle = vi.fn()
    renderRow({ row: declaredRow(say, 'greet'), onToggle })

    const head = screen.getByTestId('step')
    expect(head).toBeDisabled()
    expect(head).toHaveAttribute('data-state', 'queued')

    fireEvent.click(head)

    expect(onToggle).not.toHaveBeenCalled()
    expect(screen.queryByTestId('step-pane')).not.toBeInTheDocument()
  })

  it('reports the click as the key it holds, and shows the body only while the page says open', () => {
    const onToggle = vi.fn()
    const row = stepsOfJob(hello, finished, 'slow', 0)[0]!
    const { rerender } = renderRow({ row, onToggle })

    fireEvent.click(screen.getByTestId('step'))
    expect(onToggle).toHaveBeenCalledWith('slow/0/start')
    // The row never opens itself: `open` is the page's.
    expect(screen.queryByTestId('step-pane')).not.toBeInTheDocument()

    rerender(
      <Provider store={makeStore()}>
        <MemoryRouter>
          <ul>
            <StepRow def={hello} state={finished} row={row} open live={false} onToggle={onToggle} />
          </ul>
        </MemoryRouter>
      </Provider>,
    )
    expect(screen.getByTestId('step-pane')).toBeInTheDocument()
    expect(screen.getByTestId('step')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('step').getAttribute('aria-controls')).toBe(
      screen.getByTestId('step-pane').closest('.step-row-body')!.id,
    )
  })
})

describe('StepRow — headless badge', () => {
  it('reads `headless: skip` in declared mode for a step declaring it', () => {
    renderRow({ row: declaredRow(review, 'confirm'), mode: 'declared' })
    expect(screen.getByText('headless: skip')).toBeInTheDocument()
  })

  // Both spellings are legal (07) and `headlessMode` reads them the same way;
  // every example workflow but one uses the object form, so the bare scalar
  // reached the row untested (apps#382).
  it('reads the bare `headless: skip` scalar the same as the object form', () => {
    renderRow({ row: declaredRow(bareSkip, 'confirm'), mode: 'declared' })
    expect(screen.getByText('headless: skip')).toBeInTheDocument()
  })

  it('reads the bare `headless: auto` scalar (interactive: pick/choose)', () => {
    renderRow({ row: declaredRow(choose, 'pick'), mode: 'declared' })
    expect(screen.getByText('headless: auto')).toBeInTheDocument()
  })

  it('never shows the badge in run mode for the bare form either', () => {
    renderRow({ row: declaredRow(bareSkip, 'confirm'), mode: 'run' })
    expect(screen.queryByText(/^headless/)).not.toBeInTheDocument()
  })

  it('shows no badge in declared mode for a step with no `headless` at all', () => {
    renderRow({ row: declaredRow(say, 'greet'), mode: 'declared' })
    expect(screen.queryByText(/^headless/)).not.toBeInTheDocument()
  })

  it('never shows the badge in run mode, even for a step that declares headless: skip', () => {
    renderRow({ row: declaredRow(review, 'confirm'), mode: 'run' })
    expect(screen.queryByText(/^headless/)).not.toBeInTheDocument()
  })

  it('opens on the declaration in declared mode, and a declared row is never disabled', () => {
    renderRow({ row: declaredRow(review, 'confirm'), mode: 'declared', open: true })

    expect(screen.getByTestId('step')).toHaveAttribute('data-state', 'declared')
    expect(screen.getByTestId('step')).toBeEnabled()
    expect(document.querySelector('.declaration')).toHaveTextContent('review')
  })

  it('shows no declared outputs on the head: there the row is about the step, not its promises', () => {
    renderRow({ row: declaredRow(say, 'greet'), mode: 'declared' })
    expect(within(screen.getByTestId('step')).queryByText('line')).not.toBeInTheDocument()
  })
})

describe('StepRow — data-flow', () => {
  it('stamps data-flow only for a hover this row is the source or a target of', () => {
    const row = stepsOfJob(hello, finished, 'greet', 0)[0]! // greet/0/say declares `line`
    const { rerender } = renderRow({ row })
    expect(screen.getByTestId('step')).not.toHaveAttribute('data-flow')

    const asSource = (
      <Provider store={makeStore()}>
        <MemoryRouter>
          <ul>
            <StepRow
              def={hello}
              state={finished}
              row={row}
              open={false}
              live={false}
              onToggle={vi.fn()}
              flow={flowFor(hello, { job: 'greet', step: 'say', output: 'line' })}
            />
          </ul>
        </MemoryRouter>
      </Provider>
    )
    rerender(asSource)
    expect(screen.getByTestId('step')).toHaveAttribute('data-flow', 'source')

    // `greet`'s collected `lines` is read by `slow/start`, so that row is a target.
    const slow = stepsOfJob(hello, finished, 'slow', 0)[0]!
    rerender(
      <Provider store={makeStore()}>
        <MemoryRouter>
          <ul>
            <StepRow
              def={hello}
              state={finished}
              row={slow}
              open={false}
              live={false}
              onToggle={vi.fn()}
              flow={flowFor(hello, { job: 'greet', output: 'lines' })}
            />
          </ul>
        </MemoryRouter>
      </Provider>,
    )
    expect(screen.getByTestId('step')).toHaveAttribute('data-flow', 'target')
  })
})

describe('StepRow — the body', () => {
  it('renders the waiting form inside the open row on the live path', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const state = store.getState().run.state!

    renderRow(
      { row: stepsOfJob(hello, state, 'confirm', 0)[0]!, open: true, live: true },
      state,
      store,
    )

    expect(screen.getByTestId('form-step')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument()
  })

  it('falls back to the tabs on a read-only replay of the very same step', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const state = store.getState().run.state!

    renderRow(
      { row: stepsOfJob(hello, state, 'confirm', 0)[0]!, open: true, live: false },
      state,
      store,
    )

    expect(screen.queryByTestId('form-step')).not.toBeInTheDocument()
    expect(screen.getByTestId('step-pane')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Input' })).toBeInTheDocument()
  })

  it('closes on Esc inside the body, through the page’s own toggle', () => {
    const onToggle = vi.fn()
    renderRow({ row: stepsOfJob(hello, finished, 'slow', 0)[0]!, open: true, onToggle })

    fireEvent.keyDown(screen.getByTestId('step-pane'), { key: 'Escape' })

    expect(onToggle).toHaveBeenCalledWith('slow/0/start')
  })
})
