/**
 * The waiting form step's pane (03, 08: "the pane is the form") — the built-in
 * renderer used mid-run, driven against the real runner middleware + the MSW
 * mock backend at `hello`'s own `confirm/0/review` waiting point (Task 17's
 * scenario-2 harness, lifted into `src/test/helloHarness.ts`).
 *
 * The third test forces an invalid submit through a stubbed `FieldControl`
 * (real `FieldControl`'s boolean checkbox can only ever emit `true`/`false` —
 * there is no way to type an invalid value through it) to prove
 * `completeFormStep`'s per-field errors reach the pane, and that a rejected
 * submit dispatches nothing at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { FormStepPane } from './FormStepPane'
import {
  hello,
  REVIEW_KEY,
  resetHelloHarness,
  startHelloAtConfirmWaiting,
} from '../../test/helloHarness'
import type { FieldControlProps } from '../kickoff/FieldControl'

let breakApproved = false

vi.mock('../kickoff/FieldControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../kickoff/FieldControl')>()

  function StubbedFieldControl(props: FieldControlProps) {
    if (props.name === 'approved' && breakApproved) {
      return (
        <div className="field">
          <label htmlFor="broken-approved">approved</label>
          <input
            id="broken-approved"
            data-testid="broken-approved"
            value={typeof props.value === 'string' ? props.value : ''}
            onChange={(e) => props.onChange(e.target.value)}
          />
          {props.error && <p className="field-error">{props.error}</p>}
        </div>
      )
    }
    return <actual.FieldControl {...props} />
  }

  return { ...actual, FieldControl: StubbedFieldControl }
})

afterEach(() => {
  breakApproved = false
  resetHelloHarness()
})

describe('FormStepPane (hello confirm/0/review, waiting)', () => {
  it('shows the approved toggle (default true) and the report field prefilled from needs.slow.outputs.report', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const state = store.getState().run.state!
    const slowReport = state.steps['slow/0/start']?.outputs?.report
    expect(typeof slowReport).toBe('string')

    render(
      <Provider store={store}>
        <FormStepPane def={hello} state={state} stepKey={REVIEW_KEY} />
      </Provider>,
    )

    expect(screen.getByLabelText(/^approved/)).toBeChecked()
    expect(screen.getByLabelText('report')).toHaveValue(slowReport as string)
    expect(screen.getByRole('button', { name: 'Finish' })).toBeInTheDocument()
  })

  it('a valid submit succeeds the step and the run goes on to finish', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    const state = store.getState().run.state!

    render(
      <Provider store={store}>
        <FormStepPane def={hello} state={state} stepKey={REVIEW_KEY} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))

    // The dispatch inside `handleSubmit` is synchronous — the reducer has
    // already folded `step.succeeded` by the time `fireEvent` returns.
    expect(store.getState().run.state?.steps[REVIEW_KEY]?.status).toBe('succeeded')

    // The middleware's own scheduling effect (Task 17) is what takes the run
    // on to `finish` — that part is async.
    await vi.waitFor(() => {
      expect(store.getState().run.state?.status).toBe('succeeded')
    })
  })

  it('surfaces the field error and dispatches nothing when a control submits a value its type rejects', async () => {
    breakApproved = true
    const { store } = await startHelloAtConfirmWaiting()
    const state = store.getState().run.state!

    render(
      <Provider store={store}>
        <FormStepPane def={hello} state={state} stepKey={REVIEW_KEY} />
      </Provider>,
    )

    fireEvent.change(screen.getByTestId('broken-approved'), { target: { value: 'yes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }))

    expect(await screen.findByText(/expected a boolean/i)).toBeInTheDocument()
    expect(store.getState().run.state?.steps[REVIEW_KEY]?.status).toBe('waiting')
  })
})
