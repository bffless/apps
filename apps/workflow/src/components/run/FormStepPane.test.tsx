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
import type { Definition, FileRef, RunState, StepKey } from '../../lib/runner/types'
import type { RunStore } from '../../lib/runStore'
import type { AppStore } from '../../store'
import { makeStore } from '../../store'
import type { RunnerDeps } from '../../store/runnerMiddleware'
import { runClosed, runOpened, runReplaced } from '../../store/runSlice'
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
  // The runner middleware's controllers/heartbeats/write-queues are module
  // singletons (Task 17), so every store this file opened closes itself.
  for (const store of paneStores) store.dispatch(runClosed())
  paneStores.length = 0
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

const SCAN_A: FileRef = { ...UPLOADED, path: 'w/inputs/17/a.png', name: 'a.png', url: '/api/uploads/w/inputs/17/a.png' }
const SCAN_B: FileRef = { ...UPLOADED, path: 'w/inputs/17/b.png', name: 'b.png', url: '/api/uploads/w/inputs/17/b.png' }

/** The same form with `list: true` — a mid-run field that collects several files. */
const LIST_FILE_FORM: Definition = toDefinition({
  name: 'Attach',
  jobs: {
    j: {
      steps: [
        { id: 'attach', uses: 'form', with: { fields: { scans: { type: 'file', list: true } }, submit: 'Attach' } },
      ],
    },
  },
}) as Definition

// Same job/index/step id as the single-file form, so the same waiting state serves both.
const SCANS_KEY = ATTACH_KEY

/** One waiting `form` step and nothing else — the state the pane opens against. */
function waitingFormState(runId: string): RunState {
  return {
    runId,
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

const fileFormState = () => waitingFormState('run_ATTACH')
const listFormState = () => waitingFormState('run_SCANS')

/** Every write a form-pane test makes goes nowhere: this suite is not about persistence. */
const inertRunStore: RunStore = {
  createRun: async () => {},
  patchRun: async () => {},
  upsertStep: async () => {},
  lease: async () => ({ ok: true }),
}

const inertDeps: RunnerDeps = {
  http: async () => ({ ok: true, status: 200, body: {} }),
  clock: { now: () => 2_000, sleep: async () => {} },
  runStore: inertRunStore,
  registerFile: async () => {
    throw new Error('registerFile: not expected in a form-pane test')
  },
}

const paneStores: AppStore[] = []

/**
 * A **real** store — real reducers, real runner middleware — holding one
 * waiting form step, so what the pane submits is folded by the engine and the
 * assertions below can read the resulting run state.
 *
 * This was a hand-rolled `{getState, subscribe, dispatch}` whose `getState()`
 * answered `{run: {state: null}}` to every question. Nothing here reads a
 * selector today, but the day the pane (or anything it renders) does, that
 * store lies rather than fails, and the test breaks a long way from the cause.
 *
 * `readonly` mode plus the inert `RunStore` keep the test to the pane's own
 * job: the event is persisted through a fake and the scheduler does not run
 * the rest of the run on, which is Task 17's test to make, not this one's.
 */
function paneStore(def: Definition, state: RunState): AppStore {
  const store = makeStore(inertDeps)
  store.dispatch(runOpened({ meta: { def, yaml: '# fixture\n', workflowName: 'Attach' } }))
  store.dispatch(runReplaced({ state, mode: 'readonly' }))
  paneStores.push(store)
  return store
}

/** The step as the engine now holds it — status, outputs, the lot. */
const recorded = (store: AppStore, key: StepKey) => store.getState().run.state?.steps[key]

describe('FormStepPane — file fields (Task 18)', () => {
  it('renders a file picker instead of the "not supported" notice', () => {
    const state = fileFormState()
    render(
      <Provider store={paneStore(FILE_FORM, state)}>
        <FormStepPane def={FILE_FORM} state={state} stepKey={ATTACH_KEY} upload={vi.fn()} />
      </Provider>,
    )

    const input = screen.getByLabelText('scan') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(screen.queryByText(/not supported here yet/i)).not.toBeInTheDocument()
  })

  it('uploads the picked file and submits its File ref as the step output', async () => {
    const upload = vi.fn().mockResolvedValue(UPLOADED)
    const state = fileFormState()
    const store = paneStore(FILE_FORM, state)
    render(
      <Provider store={store}>
        <FormStepPane def={FILE_FORM} state={state} stepKey={ATTACH_KEY} upload={upload} />
      </Provider>,
    )

    const file = new File(['bytes'], 'scan.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('scan'), { target: { files: [file] } })
    expect(upload).toHaveBeenCalledWith(file, expect.any(Function))

    await waitFor(() => expect(screen.getByText('scan.png')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    expect(recorded(store, ATTACH_KEY)).toMatchObject({
      status: 'succeeded',
      outputs: { scan: UPLOADED },
    })
  })

  // `list: true` mid-run (apps#379): the multi-file path had no test at all,
  // and it is the one that has to append rather than replace.
  it('uploads a multi-file pick and records every ref, in order', async () => {
    const upload = vi.fn(async (file: File) => (file.name === 'a.png' ? SCAN_A : SCAN_B))
    const state = listFormState()
    const store = paneStore(LIST_FILE_FORM, state)
    render(
      <Provider store={store}>
        <FormStepPane def={LIST_FILE_FORM} state={state} stepKey={SCANS_KEY} upload={upload} />
      </Provider>,
    )

    const input = screen.getByLabelText('scans') as HTMLInputElement
    expect(input.multiple).toBe(true)

    fireEvent.change(input, {
      target: {
        files: [
          new File(['a'], 'a.png', { type: 'image/png' }),
          new File(['b'], 'b.png', { type: 'image/png' }),
        ],
      },
    })

    await waitFor(() => expect(screen.getByText('b.png')).toBeInTheDocument())
    expect(screen.getByText('a.png')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    expect(recorded(store, SCANS_KEY)).toMatchObject({
      status: 'succeeded',
      outputs: { scans: [SCAN_A, SCAN_B] },
    })
  })

  it('a second pick adds to the first rather than replacing it', async () => {
    const upload = vi.fn(async (file: File) => (file.name === 'a.png' ? SCAN_A : SCAN_B))
    const state = listFormState()
    const store = paneStore(LIST_FILE_FORM, state)
    render(
      <Provider store={store}>
        <FormStepPane def={LIST_FILE_FORM} state={state} stepKey={SCANS_KEY} upload={upload} />
      </Provider>,
    )

    const input = screen.getByLabelText('scans')
    fireEvent.change(input, { target: { files: [new File(['a'], 'a.png', { type: 'image/png' })] } })
    await waitFor(() => expect(screen.getByText('a.png')).toBeInTheDocument())
    fireEvent.change(input, { target: { files: [new File(['b'], 'b.png', { type: 'image/png' })] } })
    await waitFor(() => expect(screen.getByText('b.png')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Attach' }))

    expect(recorded(store, SCANS_KEY)).toMatchObject({ outputs: { scans: [SCAN_A, SCAN_B] } })
  })
})
