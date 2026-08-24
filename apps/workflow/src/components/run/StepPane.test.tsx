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
import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, describe, expect, it } from 'vitest'
import { StepPane } from './StepPane'
import { hello, REVIEW_KEY, resetHelloHarness, startHelloAtConfirmWaiting } from '../../test/helloHarness'
import type { RunState, StepState } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'

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

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
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
