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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { FormStepPane } from './FormStepPane'
import type { Definition, FileRef, RunState } from '../../lib/runner/types'
import type { AppStore } from '../../store'
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

// ---------------------------------------------------------------------------
// Task 18 — `file` fields in a mid-run form (the M1 gap this pays down)
// ---------------------------------------------------------------------------

const UPLOADED: FileRef = {
  path: 'workflows/hello/hello/inputs/17/scan.png',
  name: 'scan.png',
  contentType: 'image/png',
  size: 5,
  url: '/api/uploads/hello/hello/inputs/17/scan.png',
}

const FILE_FORM: Definition = toDefinition({
  name: 'Attach',
  jobs: {
    j: {
      steps: [{ id: 'attach', uses: 'form', with: { fields: { scan: { type: 'file' } }, submit: 'Attach' } }],
    },
  },
}) as Definition

const ATTACH_KEY = 'j/0/attach'

function fileFormState(): RunState {
  return {
    runId: 'run_ATTACH',
    impl: 'hello',
    workflow: 'hello',
    status: 'running',
    headless: false,
    inputs: {},
    steps: {
      [ATTACH_KEY]: {
        key: ATTACH_KEY,
        job: 'j',
        index: 0,
        stepId: 'attach',
        kind: 'form',
        status: 'waiting',
        attempt: 1,
        annotations: [],
      },
    },
    expansions: {},
    annotations: [],
    startedAt: 1_000,
  }
}

/** A store that only records what the pane dispatched — the middleware is Task 17's test, not this one's. */
function captureStore() {
  const dispatched: { type: string; payload?: unknown }[] = []
  const store = {
    getState: () => ({ run: { state: null } }),
    subscribe: () => () => {},
    dispatch: (action: { type: string; payload?: unknown }) => {
      dispatched.push(action)
      return action
    },
  }
  return { store: store as unknown as AppStore, dispatched }
}

describe('FormStepPane — file fields (Task 18)', () => {
  it('renders a file picker instead of the "not supported" notice', () => {
    const { store } = captureStore()
    render(
      <Provider store={store}>
        <FormStepPane def={FILE_FORM} state={fileFormState()} stepKey={ATTACH_KEY} upload={vi.fn()} />
      </Provider>,
    )

    const input = screen.getByLabelText('scan') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(screen.queryByText(/not supported here yet/i)).not.toBeInTheDocument()
  })

  it('uploads the picked file and submits its File ref as the step output', async () => {
    const { store, dispatched } = captureStore()
    const upload = vi.fn().mockResolvedValue(UPLOADED)
    render(
      <Provider store={store}>
        <FormStepPane def={FILE_FORM} state={fileFormState()} stepKey={ATTACH_KEY} upload={upload} />
      </Provider>,
    )

    const file = new File(['bytes'], 'scan.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('scan'), { target: { files: [file] } })
    expect(upload).toHaveBeenCalledWith(file, expect.any(Function))

    await waitFor(() => expect(screen.getByText('scan.png')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    const succeeded = dispatched.find((a) => (a.payload as { type?: string } | undefined)?.type === 'step.succeeded')
    expect(succeeded).toBeDefined()
    expect((succeeded!.payload as { outputs: Record<string, unknown> }).outputs).toEqual({ scan: UPLOADED })
  })
})
