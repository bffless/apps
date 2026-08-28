/**
 * `timeout-minutes` on a `form` step (Task 9, Decision 10) — the budget the
 * middleware puts on a step that is waiting for a person.
 *
 * A form is the kind with no launcher of its own: the middleware dispatches its
 * `step.waiting` inline and then nothing happens until somebody submits. So the
 * clock is armed from the `runEvent` listener, off `step.waiting` itself, which
 * is also the event a **resumed** form replays to — one path for a fresh step
 * and a resumed one, which is what these tests pin down.
 *
 * Driven through the real middleware against the MSW-backed run store
 * (`trackedHelloStore`) and a virtual clock: nothing here mocks the timer, so a
 * budget that is never armed shows up as a step that never fails.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { HttpResponse, http } from 'msw'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { completeFormStep, formInitialValues } from '../lib/runner/adapters/form'
import { db, nextId, stepRowKey } from '../mocks/db'
import { server } from '../mocks/server'
import { replayRun } from '../lib/runner/replay'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { AppStore } from './index'
import { flush, pumpUntil, resetHelloHarness, trackedHelloStore } from '../test/helloHarness'
import { startRun } from './runnerActions'
import { runEvent, runOpened, runReplaced } from './runSlice'

afterEach(() => {
  resetHelloHarness()
})

const YAML = '# a timed form\n'
const REVIEW: StepKey = stepKey('confirm', 0, 'review')

/**
 * One job, one form — hello's `confirm/review` in miniature, because hello's
 * own review step declares no `timeout-minutes` (and must keep not declaring
 * one: its interactive smoke waits for a person indefinitely).
 */
function withForm(extra: Record<string, unknown> = {}): Definition {
  return toDefinition({
    name: 'Timed form',
    jobs: {
      confirm: {
        steps: [
          {
            id: 'review',
            uses: 'form',
            ...extra,
            with: {
              title: 'Does this look right?',
              fields: { approved: { type: 'boolean', default: true } },
              submit: 'Finish',
            },
          },
        ],
        outputs: { approved: '${{ steps.review.outputs.approved }}' },
      },
    },
  }) as Definition
}

const reviewStep = (def: Definition) => {
  const found = def.jobs.confirm?.steps[0]
  if (!found) throw new Error('no confirm/review step')
  return found
}

/** Start the workflow and pump until its form is `waiting` on a person. */
async function startFormRun(
  def: Definition,
): Promise<{ store: AppStore; advance: (ms: number) => Promise<void> }> {
  const { store, advance } = trackedHelloStore()
  store.dispatch(
    startRun({ impl: 'hello', workflow: 'timed-form', def, yaml: YAML, workflowName: 'Timed form', values: {} }),
  )
  await pumpUntil(advance, () => store.getState().run.state?.steps[REVIEW]?.status === 'waiting')
  return { store, advance }
}

/** Submit the form with its own defaults — `FormStepPane`'s "Finish" click, at the store level. */
function submitReview(store: AppStore, def: Definition): void {
  const state = store.getState().run.state!
  const step = reviewStep(def)
  const values = formInitialValues({ step, def, state, job: 'confirm', index: 0 })
  const result = completeFormStep({ step, key: REVIEW, job: 'confirm', index: 0, def, state, values, at: 2_000 })
  if (!result.ok) throw new Error(`submitReview: form rejected ${JSON.stringify(result.errors)}`)
  store.dispatch(runEvent(result.event))
}

const stepState = (store: AppStore) => store.getState().run.state!.steps[REVIEW]

/** The step row as the mock backend holds it — the record the live state must not run ahead of. */
const stepRow = (store: AppStore) =>
  db.steps.get(stepRowKey(store.getState().run.state!.runId, REVIEW))

describe('form steps — timeout-minutes (Decision 10)', () => {
  it('fails TIMEOUT when nobody submits inside the budget', async () => {
    const def = withForm({ 'timeout-minutes': 1 })
    const { store, advance } = await startFormRun(def)

    await advance(59_000)
    expect(stepState(store).status).toBe('waiting')

    await advance(1_000)
    expect(stepState(store)).toMatchObject({
      status: 'failed',
      error: { code: 'TIMEOUT', message: 'the step exceeded its `timeout-minutes` budget' },
    })
    expect(store.getState().run.state!.status).toBe('failed')
  })

  it('waits indefinitely for a person when the step declares no budget', async () => {
    const { store, advance } = await startFormRun(withForm())

    await advance(30 * 60_000)
    expect(stepState(store).status).toBe('waiting')
  })

  it('is disarmed by a submit — no failure lands after the budget would have', async () => {
    const def = withForm({ 'timeout-minutes': 1 })
    const { store, advance } = await startFormRun(def)

    submitReview(store, def)
    await flush()
    expect(stepState(store).status).toBe('succeeded')

    await advance(5 * 60_000)
    // Not `failed`: a fired clock that finds the step terminal does nothing,
    // and the terminal event disarmed it anyway.
    expect(stepState(store).status).toBe('succeeded')
    expect(store.getState().run.state!.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// A parked run: the clock stops with everything else that writes
// ---------------------------------------------------------------------------

describe('form steps — a run parked by a write failure', () => {
  it('disarms the clock: a paused run gets no timeout, and its row stays waiting', async () => {
    const def = withForm({ 'timeout-minutes': 1 })
    const { store, advance } = await startFormRun(def)
    expect(stepRow(store)!.status).toBe('waiting')

    // Every write from here on fails, both tries (05: a run whose write still
    // fails is parked rather than continuing unrecorded).
    let stepWrites = 0
    server.use(
      http.post('/api/workflow/run/update', () => new HttpResponse(null, { status: 500 })),
      http.post('/api/workflow/run-step', () => {
        stepWrites += 1
        return new HttpResponse(null, { status: 500 })
      }),
    )

    // Any event will do — this one only patches the run row.
    store.dispatch(
      runEvent({
        type: 'run.annotation',
        annotation: { level: 'notice', message: 'something to write' },
        at: 1_500,
      }),
    )
    await flush()
    expect(store.getState().run.paused).toBeDefined()

    await advance(5 * 60_000)

    // No `step.failed`: the timeout would have been written into a run whose
    // writes are failing, parking it again and putting live state ahead of a
    // row that still says `waiting`.
    expect(stepState(store).status).toBe('waiting')
    expect(store.getState().run.state!.status).toBe('running')
    expect(stepWrites).toBe(0)
    expect(stepRow(store)!.status).toBe('waiting')
  })
})

// ---------------------------------------------------------------------------
// Resume: the budget is measured from the row's `startedAt`, not from now
// ---------------------------------------------------------------------------

/** A run row + a form row left `waiting` at `startedAt` by the tab that went away. */
function waitingRows(runId: string, def: Definition, startedAt: number): { run: RunRow; steps: StepRow[] } {
  return {
    run: {
      runId,
      impl: 'hello',
      workflow: 'timed-form',
      workflowName: 'Timed form',
      definition: def.raw,
      yaml: YAML,
      inputs: {},
      status: 'running',
      headless: false,
      startedAt: 1_000,
      finishedAt: null,
      outputs: null,
      annotations: [],
    },
    steps: [
      {
        runId,
        key: REVIEW,
        job: 'confirm',
        index: 0,
        step: 'review',
        kind: 'form',
        status: 'waiting',
        attempt: 1,
        inputs: { title: 'Does this look right?' },
        annotations: [],
        startedAt,
      },
    ],
  }
}

/**
 * Adopt the recorded run in this tab, `advance`d by `away` first — the time the
 * old tab was gone. The rows are seeded into the mock backend as well as
 * replayed: this tab takes a real lease and renews it, and a heartbeat that
 * found no such run would (rightly) hand the tab back its readonly view and
 * disarm every clock on it, which is a different test.
 */
async function resumeWaitingForm(
  def: Definition,
  a: { away: number; startedAt?: number },
): Promise<{ store: AppStore; advance: (ms: number) => Promise<void> }> {
  const { store, advance } = trackedHelloStore()
  await advance(a.away)
  const { run, steps } = waitingRows('run_resumed', def, a.startedAt ?? 1_000)
  db.runs.set(run.runId, { ...run, _id: nextId() })
  for (const row of steps) db.steps.set(stepRowKey(row.runId, row.key), { ...row, _id: nextId() })

  store.dispatch(runOpened({ meta: { def, yaml: YAML, workflowName: 'Timed form' } }))
  store.dispatch(runReplaced({ state: replayRun(run, steps, def), mode: 'live' }))
  await flush()
  return { store, advance }
}

describe('form steps — timeout-minutes on resume', () => {
  it('re-arms from the recorded startedAt: only the remaining budget is left', async () => {
    const def = withForm({ 'timeout-minutes': 1 })
    // 40s of the minute were spent before this tab adopted the run.
    const { store, advance } = await resumeWaitingForm(def, { away: 40_000 })
    expect(stepState(store).status).toBe('waiting')

    await advance(19_000)
    expect(stepState(store).status).toBe('waiting')

    await advance(1_000)
    expect(stepState(store)).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } })
  })

  it('fails at once when the budget was spent while the tab was away', async () => {
    const def = withForm({ 'timeout-minutes': 1 })
    const { store } = await resumeWaitingForm(def, { away: 120_000 })

    // No `advance`: the budget is already gone, so adoption is what fails it.
    expect(stepState(store)).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } })
  })

  it('leaves a resumed form alone when it declares no budget', async () => {
    const { store, advance } = await resumeWaitingForm(withForm(), { away: 120_000 })

    await advance(30 * 60_000)
    expect(stepState(store).status).toBe('waiting')
  })
})
