import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { initialRunState, runReducer } from './reducer'
import { nextActions, type NextAction } from './next'
import type { Annotation, Definition, RunEvent, RunState, StepKey } from './types'
import { stepKey } from './types'
import { completeFormStep } from './adapters/form'
import { eventToWrites, type PersistWrite, type RunRow, type StepRow } from './rows'
import { replayRun, rowsToEvents } from './replay'

// ---------------------------------------------------------------------------
// Fixture — three jobs: a seed, a matrix fan-out (with a skipped step), a tail.
// ---------------------------------------------------------------------------

const pipe = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  uses: 'pipeline',
  with: { path: 'echo' },
  ...extra,
})

const def: Definition = toDefinition({
  name: 'Replay',
  jobs: {
    seed: {
      steps: [pipe('make')],
      outputs: { names: '${{ steps.make.outputs.names }}' },
    },
    fan: {
      needs: 'seed',
      strategy: { matrix: { who: '${{ needs.seed.outputs.names }}' } },
      steps: [pipe('work'), pipe('never', { if: '${{ false }}' })],
      outputs: { line: '${{ steps.work.outputs.line }}' },
    },
    tail: { needs: 'fan', steps: [pipe('done')] },
  },
})

const RUN_ID = 'run_REPLAY'
const YAML = '# the workflow file\n'

// ---------------------------------------------------------------------------
// A tiny in-memory {runs, steps} store driven purely by `eventToWrites`.
// ---------------------------------------------------------------------------

interface Store {
  runs: Record<string, RunRow>
  steps: Record<string, StepRow>
}

const newStore = (): Store => ({ runs: {}, steps: {} })

function applyWrite(store: Store, write: PersistWrite): void {
  if (write.table === 'runs') {
    if (write.op === 'create') {
      store.runs[write.row.runId] = { ...write.row }
      return
    }
    const existing = store.runs[write.id]
    if (!existing) throw new Error(`patch of unknown run ${write.id}`)
    store.runs[write.id] = { ...existing, ...write.patch }
    return
  }
  const id = `${write.runId}::${write.key}`
  const existing = store.steps[id]
  store.steps[id] = {
    ...(existing ?? {}),
    ...write.patch,
    runId: write.runId,
    key: write.key,
  } as StepRow
}

let clock = 10_000
const now = () => (clock += 1)

function makeRunRow(state: RunState, d: Definition): RunRow {
  return {
    runId: state.runId,
    impl: state.impl,
    workflow: state.workflow,
    workflowName: d.name,
    workflowVersion: 'dep_123@abc1234',
    definition: d.raw,
    yaml: YAML,
    inputs: state.inputs,
    status: state.status,
    headless: state.headless,
    startedBy: 'user_bob',
    startedAt: state.startedAt,
    leaseOwner: 'tab_1',
    leaseUntil: state.startedAt + 60_000,
  }
}

/** Fold one event through the real reducer, then persist it through the real write path. */
function dispatch(store: Store, state: RunState, event: RunEvent, d: Definition = def): RunState {
  const next = runReducer(state, event)
  for (const write of eventToWrites(event, { state: next, runRow: () => makeRunRow(next, d) })) {
    applyWrite(store, write)
  }
  return next
}

function startRun(store: Store, d: Definition = def): RunState {
  const seed = initialRunState({
    runId: RUN_ID,
    impl: 'demo',
    workflow: 'replay',
    inputs: { note: 'hi' },
    headless: false,
    startedAt: now(),
  })
  return dispatch(
    store,
    seed,
    {
      type: 'run.started',
      runId: RUN_ID,
      impl: 'demo',
      workflow: 'replay',
      inputs: { note: 'hi' },
      headless: false,
      at: seed.startedAt,
    },
    d,
  )
}

const storedSteps = (store: Store): StepRow[] => Object.values(store.steps)

/** The 05 response budget, measured the way `trimResponse` measures it. */
const BUDGET = 256 * 1024
const serializedSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

// ---------------------------------------------------------------------------
// A scheduler-driven run: every started step is taken to a terminal state.
// ---------------------------------------------------------------------------

interface Outcome {
  retry?: boolean
  fail?: boolean
  outputs?: Record<string, unknown>
  summary?: string
}
type Plan = Record<StepKey, Outcome>

function kindOf(job: string, stepId: string) {
  const found = def.jobs[job]?.steps.find((s) => s.id === stepId)
  if (!found) throw new Error(`no step ${job}/${stepId}`)
  return found.uses
}

function runStep(
  store: Store,
  state: RunState,
  job: string,
  index: number,
  stepId: string,
  plan: Plan,
): RunState {
  const key = stepKey(job, index, stepId)
  const outcome = plan[key] ?? {}
  const inputs = { path: 'echo', who: index }

  state = dispatch(store, state, {
    type: 'step.queued',
    key,
    job,
    index,
    stepId,
    kind: kindOf(job, stepId),
    at: now(),
  })
  state = dispatch(store, state, { type: 'step.started', key, inputs, at: now() })

  if (outcome.retry) {
    state = dispatch(store, state, {
      type: 'step.retrying',
      key,
      error: { code: 'FLAKY', message: 'transient', status: 502 },
      at: now(),
    })
    state = dispatch(store, state, { type: 'step.started', key, inputs, at: now() })
  }

  if (outcome.fail) {
    return dispatch(store, state, {
      type: 'step.failed',
      key,
      error: { code: 'BOOM', message: 'on purpose' },
      at: now(),
    })
  }

  return dispatch(store, state, {
    type: 'step.succeeded',
    key,
    outputs: outcome.outputs ?? {},
    response: { initial: { ok: true }, last: { ok: true } },
    summary: outcome.summary,
    at: now(),
  })
}

function applyAction(store: Store, state: RunState, action: NextAction, plan: Plan): RunState {
  switch (action.kind) {
    case 'expand':
      return dispatch(store, state, {
        type: 'job.expanded',
        job: action.job,
        total: action.total,
        items: action.items,
      })
    case 'skip':
      for (const s of action.steps) {
        state = dispatch(store, state, {
          type: 'step.skipped',
          key: s.key,
          job: s.job,
          index: s.index,
          stepId: s.stepId,
          kind: s.stepKind,
          at: now(),
        })
      }
      return state
    case 'start':
      return runStep(store, state, action.job, action.index, action.stepId, plan)
    case 'finish':
      return dispatch(store, state, {
        type: 'run.finished',
        status: action.status,
        outputs: { greeting: 'done' },
        at: now(),
      })
  }
}

function drive(store: Store, state: RunState, plan: Plan): RunState {
  for (let guard = 0; guard < 200; guard++) {
    const actions = nextActions(def, state)
    if (actions.length === 0) return state
    for (const action of actions) state = applyAction(store, state, action, plan)
  }
  throw new Error('scheduler did not settle')
}

// ---------------------------------------------------------------------------
// 1. Round-trip: live run → rows → replay
// ---------------------------------------------------------------------------

describe('replayRun — round-trip against a live run', () => {
  const annotation: Annotation = { level: 'notice', message: 'kicked off by hand' }

  const plan: Plan = {
    'seed/0/make': { outputs: { names: ['ada', 'grace'] } },
    'fan/0/work': { retry: true, outputs: { line: 'hi ada' }, summary: 'greeted ada' },
    'fan/1/work': { outputs: { line: 'hi grace' }, summary: 'greeted grace' },
    'tail/0/done': { outputs: { count: 2 } },
  }

  function live() {
    const store = newStore()
    let state = startRun(store)
    state = dispatch(store, state, { type: 'run.annotation', annotation, at: now() })
    state = drive(store, state, plan)
    return { store, state }
  }

  it('drives a matrix + retry + skip run to completion', () => {
    const { state } = live()
    expect(state.status).toBe('succeeded')
    expect(state.expansions.fan.total).toBe(2)
    expect(state.steps['fan/0/work'].attempt).toBe(2)
    expect(state.steps['fan/0/never'].status).toBe('skipped')
    expect(state.steps['fan/1/never'].status).toBe('skipped')
  })

  it('replays every step to the same status/attempt/outputs/error/summary', () => {
    const { store, state } = live()
    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), def)

    expect(Object.keys(replayed.steps).sort()).toEqual(Object.keys(state.steps).sort())
    for (const key of Object.keys(state.steps)) {
      const a = state.steps[key]
      const b = replayed.steps[key]
      expect({
        key,
        status: b.status,
        attempt: b.attempt,
        outputs: b.outputs,
        error: b.error,
        summary: b.summary,
      }).toEqual({
        key,
        status: a.status,
        attempt: a.attempt,
        outputs: a.outputs,
        error: a.error,
        summary: a.summary,
      })
    }
  })

  it('replays the expansions, the run status, outputs and annotations', () => {
    const { store, state } = live()
    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), def)

    expect(replayed.expansions).toEqual(state.expansions)
    expect(replayed.status).toBe(state.status)
    expect(replayed.outputs).toEqual(state.outputs)
    expect(replayed.annotations).toEqual([annotation])
    expect(replayed.inputs).toEqual(state.inputs)
  })

  it('seeds startedBy from the run row (the run.started event does not carry it)', () => {
    const { store } = live()
    expect(replayRun(store.runs[RUN_ID], storedSteps(store), def).startedBy).toBe('user_bob')
  })

  it('schedules nothing more for a replayed finished run', () => {
    const { store } = live()
    expect(nextActions(def, replayRun(store.runs[RUN_ID], storedSteps(store), def))).toEqual([])
  })

  it('emits exactly one creation event per step row', () => {
    const { store } = live()
    const events = rowsToEvents(store.runs[RUN_ID], storedSteps(store), def)
    const created = events.flatMap((e) =>
      e.type === 'step.queued' || e.type === 'step.skipped' ? [e.key] : [],
    )
    expect(created.length).toBe(new Set(created).size)
    expect(created.sort()).toEqual(storedSteps(store).map((r) => r.key).sort())
  })
})

// ---------------------------------------------------------------------------
// 2. In-flight replay (rows up to a polling step)
// ---------------------------------------------------------------------------

describe('replayRun — an in-flight run', () => {
  const initial = { job: 'job_42', state: 'pending' }

  function inFlight() {
    const store = newStore()
    let state = startRun(store)

    state = dispatch(store, state, { type: 'job.expanded', job: 'seed', total: 1, items: [{}] })
    state = runStep(store, state, 'seed', 0, 'make', {
      'seed/0/make': { outputs: { names: ['ada', 'grace'] } },
    })

    state = dispatch(store, state, {
      type: 'job.expanded',
      job: 'fan',
      total: 2,
      items: [{ who: 'ada' }, { who: 'grace' }],
    })
    const key = stepKey('fan', 0, 'work')
    state = dispatch(store, state, {
      type: 'step.queued',
      key,
      job: 'fan',
      index: 0,
      stepId: 'work',
      kind: 'pipeline',
      at: now(),
    })
    state = dispatch(store, state, {
      type: 'step.started',
      key,
      inputs: { path: 'echo' },
      at: now(),
    })
    state = dispatch(store, state, { type: 'step.polling', key, initial, at: now() })
    return { store, state }
  }

  it('restores the polling step with its recorded initial response', () => {
    const { store } = inFlight()
    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), def)

    expect(replayed.status).toBe('running')
    expect(replayed.steps['seed/0/make'].status).toBe('succeeded')
    expect(replayed.steps['seed/0/make'].outputs).toEqual({ names: ['ada', 'grace'] })
    expect(replayed.steps['fan/0/work'].status).toBe('polling')
    expect(replayed.steps['fan/0/work'].response?.initial).toEqual(initial)
    expect(replayed.expansions.fan).toEqual({
      total: 2,
      items: [{ who: 'ada' }, { who: 'grace' }],
    })
  })

  it('proposes nothing new for the terminal or in-flight steps', () => {
    const { store } = inFlight()
    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), def)
    const actions = nextActions(def, replayed)

    // Only the untouched second matrix item is scheduled.
    expect(actions).toEqual([
      { kind: 'start', key: 'fan/1/work', job: 'fan', index: 1, stepId: 'work' },
    ])

    const proposed = actions.flatMap((a) =>
      a.kind === 'start' ? [a.key] : a.kind === 'skip' ? a.steps.map((s) => s.key) : [],
    )
    for (const key of proposed) expect(replayed.steps[key]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 3. The form path — the one step kind that never passes through `running`
// ---------------------------------------------------------------------------

/** hello's `confirm`/`review` in miniature: one job, one `form` step. */
const formDef: Definition = toDefinition({
  name: 'FormReplay',
  jobs: {
    confirm: {
      steps: [
        {
          id: 'review',
          uses: 'form',
          with: {
            title: 'Does the report look right?',
            fields: {
              approved: { type: 'boolean', default: true, required: true },
              report: { type: 'markdown', default: 'draft' },
            },
            submit: 'Finish',
          },
          summary: 'approved=${{ steps.review.outputs.approved }}',
        },
      ],
      outputs: { approved: '${{ steps.review.outputs.approved }}' },
    },
  },
})

const REVIEW = stepKey('confirm', 0, 'review')

/** The other waiting kind — an island, which *does* run (it loads) before it waits. */
const islandDef: Definition = toDefinition({
  name: 'IslandReplay',
  jobs: {
    pick: {
      steps: [
        {
          id: 'choose',
          uses: 'island',
          with: { src: 'islands/pick.html', title: 'Pick one', mode: 'quick' },
          outputs: { choice: { type: 'string' } },
        },
      ],
    },
  },
})

const CHOOSE = stepKey('pick', 0, 'choose')

function reviewStep() {
  const found = formDef.jobs.confirm?.steps[0]
  if (!found) throw new Error('no confirm/review step')
  return found
}

/** Run the form step as the harness really does: queued → waiting → (submit). */
function openForm(store: Store): RunState {
  let state = startRun(store, formDef)
  state = dispatch(
    store,
    state,
    { type: 'job.expanded', job: 'confirm', total: 1, items: [{}] },
    formDef,
  )
  state = dispatch(
    store,
    state,
    {
      type: 'step.queued',
      key: REVIEW,
      job: 'confirm',
      index: 0,
      stepId: 'review',
      kind: 'form',
      at: now(),
    },
    formDef,
  )
  // No `step.started`: a form goes straight from queued to waiting for a human.
  // `step.waiting` is what stamps its `startedAt` (Task 9) — the moment the
  // wait began, and what a `timeout-minutes` budget is measured from.
  return dispatch(store, state, { type: 'step.waiting', key: REVIEW, at: now() }, formDef)
}

function submitForm(store: Store, state: RunState, values: Record<string, unknown>): RunState {
  const result = completeFormStep({
    step: reviewStep(),
    key: REVIEW,
    job: 'confirm',
    index: 0,
    def: formDef,
    state,
    values,
    at: now(),
  })
  if (!result.ok) throw new Error(`form rejected: ${JSON.stringify(result.errors)}`)
  return dispatch(store, state, result.event, formDef)
}

describe('replayRun — a form step', () => {
  it('writes the startedAt stamped at step.waiting onto the row (Task 9)', () => {
    const store = newStore()
    const state = openForm(store)

    const waitingRow = store.steps[`${RUN_ID}::${REVIEW}`]
    expect(waitingRow.status).toBe('waiting')
    expect(waitingRow.startedAt).toBe(state.steps[REVIEW].startedAt)
    expect(waitingRow.startedAt).toBeGreaterThan(0)

    // And it survives the submit: the terminal write patches other columns.
    submitForm(store, state, { approved: true, report: 'looks good' })
    const finishedRow = store.steps[`${RUN_ID}::${REVIEW}`]
    expect(finishedRow.status).toBe('succeeded')
    expect(finishedRow.startedAt).toBe(waitingRow.startedAt)
  })

  it('replays queued → waiting → succeeded, never queued → succeeded', () => {
    const store = newStore()
    submitForm(store, openForm(store), { approved: true, report: 'looks good' })

    const types = rowsToEvents(store.runs[RUN_ID], storedSteps(store), formDef)
      .filter((e) => 'key' in e && e.key === REVIEW)
      .map((e) => e.type)
    // `queued → succeeded` is not in STEP_TRANSITIONS: without the waiting hop
    // the reducer would throw IllegalTransition on Resume.
    expect(types).toEqual(['step.queued', 'step.waiting', 'step.succeeded'])
  })

  it('round-trips a submitted form: status, outputs and summary', () => {
    const store = newStore()
    let state = submitForm(store, openForm(store), { approved: true, report: 'looks good' })
    state = dispatch(
      store,
      state,
      { type: 'run.finished', status: 'succeeded', outputs: { approved: true }, at: now() },
      formDef,
    )

    expect(state.steps[REVIEW].summary).toBe('approved=true')

    let replayed!: RunState
    expect(() => {
      replayed = replayRun(store.runs[RUN_ID], storedSteps(store), formDef)
    }).not.toThrow()

    expect(replayed.steps[REVIEW].status).toBe('succeeded')
    expect(replayed.steps[REVIEW].outputs).toEqual({ approved: true, report: 'looks good' })
    expect(replayed.steps[REVIEW].summary).toBe(state.steps[REVIEW].summary)
    expect(replayed.status).toBe('succeeded')
    expect(nextActions(formDef, replayed)).toEqual([])
  })

  it('replays an in-flight form row back to waiting, keeping the startedAt the clock resumes from', () => {
    const store = newStore()
    const state = openForm(store)

    const row = store.steps[`${RUN_ID}::${REVIEW}`]
    expect(row.status).toBe('waiting')

    const events = rowsToEvents(store.runs[RUN_ID], storedSteps(store), formDef)
      .filter((e) => 'key' in e && e.key === REVIEW)
      .map((e) => e.type)
    // No `step.started`: a form that is waiting never ran, whatever its row's
    // `startedAt` says (Task 9) — replaying one would put a transition in the
    // stream that never happened live.
    expect(events).toEqual(['step.queued', 'step.waiting'])

    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), formDef)
    expect(replayed.steps[REVIEW].status).toBe('waiting')
    // The resumed wait clock measures its remaining budget from this.
    expect(replayed.steps[REVIEW].startedAt).toBe(state.steps[REVIEW].startedAt)
    expect(replayed.status).toBe('running')
    // The form is still open: the scheduler must not re-propose the step.
    expect(nextActions(formDef, replayed)).toEqual([])
  })

  it('still replays a legacy form row that has no startedAt at all', () => {
    const store = newStore()
    submitForm(store, openForm(store), { approved: true, report: 'looks good' })
    // A row written before Task 9 stamped one — the shape the mock fixtures
    // (and every run recorded in M2) still have.
    const legacy = storedSteps(store).map((row) =>
      row.key === REVIEW ? { ...row, startedAt: null } : row,
    )

    const types = rowsToEvents(store.runs[RUN_ID], legacy, formDef)
      .filter((e) => 'key' in e && e.key === REVIEW)
      .map((e) => e.type)
    expect(types).toEqual(['step.queued', 'step.waiting', 'step.succeeded'])
    expect(replayRun(store.runs[RUN_ID], legacy, formDef).steps[REVIEW].status).toBe('succeeded')
  })

  it('keeps an island through step.started — it is running while it loads', () => {
    const store = newStore()
    let state = startRun(store, islandDef)
    state = dispatch(store, state, { type: 'job.expanded', job: 'pick', total: 1, items: [{}] }, islandDef)
    state = dispatch(
      store,
      state,
      { type: 'step.queued', key: CHOOSE, job: 'pick', index: 0, stepId: 'choose', kind: 'island', at: now() },
      islandDef,
    )
    state = dispatch(store, state, { type: 'step.started', key: CHOOSE, inputs: { mode: 'quick' }, at: now() }, islandDef)
    dispatch(store, state, { type: 'step.waiting', key: CHOOSE, at: now() }, islandDef)

    const types = rowsToEvents(store.runs[RUN_ID], storedSteps(store), islandDef)
      .filter((e) => 'key' in e && e.key === CHOOSE)
      .map((e) => e.type)
    expect(types).toEqual(['step.queued', 'step.started', 'step.waiting'])
  })
})

// ---------------------------------------------------------------------------
// 4. Derived events are never persisted
// ---------------------------------------------------------------------------

describe('eventToWrites', () => {
  const state = initialRunState({
    runId: RUN_ID,
    impl: 'demo',
    workflow: 'replay',
    inputs: {},
    headless: false,
    startedAt: 1,
  })

  it('returns no writes for job.expanded (job state is derived, 05)', () => {
    expect(
      eventToWrites({ type: 'job.expanded', job: 'fan', total: 2, items: [{}, {}] }, { state }),
    ).toEqual([])
  })

  // A step that dies mid-poll never reaches the terminal write that would trim
  // its response — and that untrimmed row is exactly the row Resume reads.
  it('caps the persisted polling response at the 256 KB budget (05)', () => {
    const store = newStore()
    let live = startRun(store)
    live = dispatch(store, live, { type: 'job.expanded', job: 'seed', total: 1, items: [{}] })

    const key = stepKey('seed', 0, 'make')
    live = dispatch(store, live, {
      type: 'step.queued',
      key,
      job: 'seed',
      index: 0,
      stepId: 'make',
      kind: 'pipeline',
      at: now(),
    })
    live = dispatch(store, live, { type: 'step.started', key, inputs: {}, at: now() })

    const huge = { rows: 'x'.repeat(300 * 1024) }
    expect(serializedSize(huge)).toBeGreaterThan(BUDGET)
    live = dispatch(store, live, { type: 'step.polling', key, initial: huge, at: now() })

    // The live Redux state keeps the full initial; only the row is capped.
    expect(live.steps[key].response?.initial).toEqual(huge)

    const row = store.steps[`${RUN_ID}::${key}`]
    const persisted = row.response as { initial?: unknown; truncated?: boolean }
    expect(persisted.truncated).toBe(true)
    expect(persisted.initial).toEqual({ note: 'truncated', size: serializedSize(huge) })
    expect(serializedSize(persisted)).toBeLessThan(BUDGET)

    // …and Resume reads the trimmed stub back as the polling step's initial.
    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), def)
    expect(replayed.steps[key].status).toBe('polling')
    expect(replayed.steps[key].response?.initial).toEqual(persisted.initial)
  })

  it('clears the lease when the run finishes', () => {
    const finished = runReducer(state, {
      type: 'run.finished',
      status: 'succeeded',
      outputs: { a: 1 },
      at: 9,
    })
    expect(
      eventToWrites({ type: 'run.finished', status: 'succeeded', outputs: { a: 1 }, at: 9 }, {
        state: finished,
      }),
    ).toEqual([
      {
        table: 'runs',
        op: 'patch',
        id: RUN_ID,
        patch: {
          status: 'succeeded',
          outputs: { a: 1 },
          // The Task 20 rollup: this run annotated nothing, which is a fact
          // the row states rather than omits (`rows.test.ts`).
          annotationCounts: { error: 0, warning: 0, notice: 0 },
          finishedAt: 9,
          leaseOwner: null,
          leaseUntil: null,
        },
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// 5. step.annotated — dynamic annotations on a step that has not finished
// ---------------------------------------------------------------------------

describe('step.annotated (Decision 12)', () => {
  const NOTICE: Annotation = { level: 'notice', message: 'half way' }

  /** An open form row, annotated mid-wait — the island path writes the same rows. */
  function annotatedForm(store: Store): RunState {
    const state = openForm(store)
    return dispatch(
      store,
      state,
      { type: 'step.annotated', key: REVIEW, annotations: [NOTICE], summary: 'in progress', at: now() },
      formDef,
    )
  }

  it('writes exactly one step upsert carrying both columns', () => {
    const store = newStore()
    const state = openForm(store)
    const event: RunEvent = {
      type: 'step.annotated',
      key: REVIEW,
      annotations: [NOTICE],
      summary: 'in progress',
      at: 42,
    }
    const next = runReducer(state, event)

    expect(eventToWrites(event, { state: next })).toEqual([
      {
        table: 'steps',
        op: 'upsert',
        runId: RUN_ID,
        key: REVIEW,
        patch: { annotations: [NOTICE], summary: 'in progress' },
      },
    ])
  })

  it('persists the annotation onto the waiting row', () => {
    const store = newStore()
    annotatedForm(store)

    const row = store.steps[`${RUN_ID}::${REVIEW}`]
    expect(row.status).toBe('waiting')
    expect(row.annotations).toEqual([NOTICE])
    expect(row.summary).toBe('in progress')
  })

  it('replays a non-terminal annotated row as its status event then one step.annotated', () => {
    const store = newStore()
    annotatedForm(store)

    const events = rowsToEvents(store.runs[RUN_ID], storedSteps(store), formDef).filter(
      (e) => 'key' in e && e.key === REVIEW,
    )
    expect(events.map((e) => e.type)).toEqual(['step.queued', 'step.waiting', 'step.annotated'])

    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), formDef)
    expect(replayed.steps[REVIEW].status).toBe('waiting')
    expect(replayed.steps[REVIEW].annotations).toEqual([NOTICE])
    expect(replayed.steps[REVIEW].summary).toBe('in progress')
  })

  it('leaves a terminal row alone — its annotations ride on the terminal event', () => {
    const store = newStore()
    let state = annotatedForm(store)
    state = submitForm(store, state, { approved: true, report: 'ok' })

    const events = rowsToEvents(store.runs[RUN_ID], storedSteps(store), formDef).filter(
      (e) => 'key' in e && e.key === REVIEW,
    )
    expect(events.map((e) => e.type)).toEqual(['step.queued', 'step.waiting', 'step.succeeded'])

    // The form declares no `annotations:`, so its submit evaluates to `[]` —
    // which must not wipe what `workflow.annotate` already appended.
    expect(state.steps[REVIEW].annotations).toEqual([NOTICE])
    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), formDef)
    expect(replayed.steps[REVIEW].annotations).toEqual(state.steps[REVIEW].annotations)
  })

  // A retry throws the attempt away, notes included — and replay must agree:
  // the `queued` row carries no annotations, so there is nothing to put back.
  it('is a fixed point across a retry (running → annotated → retrying)', () => {
    const store = newStore()
    let state = startRun(store)
    state = dispatch(store, state, { type: 'job.expanded', job: 'seed', total: 1, items: [{}] })

    const key = stepKey('seed', 0, 'make')
    state = dispatch(store, state, {
      type: 'step.queued',
      key,
      job: 'seed',
      index: 0,
      stepId: 'make',
      kind: 'pipeline',
      at: now(),
    })
    state = dispatch(store, state, { type: 'step.started', key, inputs: {}, at: now() })
    state = dispatch(store, state, {
      type: 'step.annotated',
      key,
      annotations: [{ level: 'notice', message: 'half way' }],
      summary: 'half',
      at: now(),
    })
    state = dispatch(store, state, {
      type: 'step.retrying',
      key,
      error: { code: 'HTTP_503', message: 'busy' },
      at: now(),
    })

    const row = store.steps[`${RUN_ID}::${key}`]
    expect(row.status).toBe('queued')
    expect(row.annotations).toEqual([])
    expect(row.summary).toBeNull()

    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), def)
    expect(replayed.steps[key].status).toBe('queued')
    expect(replayed.steps[key].attempt).toBe(state.steps[key].attempt)
    expect(replayed.steps[key].annotations).toEqual(state.steps[key].annotations)
    expect(replayed.steps[key].summary).toBe(state.steps[key].summary)
  })

  // Decision 12's union, end to end: dynamic + declared, live and on Resume.
  it('round-trips the union of dynamic and declared annotations (replay is a fixed point)', () => {
    const DECLARED: Annotation = { level: 'warning', message: 'check the cuts' }
    const store = newStore()
    let state = annotatedForm(store)
    state = dispatch(
      store,
      state,
      {
        type: 'step.succeeded',
        key: REVIEW,
        outputs: { approved: true, report: 'ok' },
        summary: 'approved=true',
        annotations: [DECLARED],
        at: now(),
      },
      formDef,
    )

    expect(state.steps[REVIEW].annotations).toEqual([NOTICE, DECLARED])
    // rows.ts writes the post-event state, so the column is already the union…
    expect(store.steps[`${RUN_ID}::${REVIEW}`].annotations).toEqual([NOTICE, DECLARED])

    // …and replaying it onto a fresh step (annotations `[]`) appends to nothing:
    // one `step.succeeded` carrying the whole column, no extra `step.annotated`.
    const events = rowsToEvents(store.runs[RUN_ID], storedSteps(store), formDef).filter(
      (e) => 'key' in e && e.key === REVIEW,
    )
    expect(events.map((e) => e.type)).toEqual(['step.queued', 'step.waiting', 'step.succeeded'])

    const replayed = replayRun(store.runs[RUN_ID], storedSteps(store), formDef)
    expect(replayed.steps[REVIEW].annotations).toEqual([NOTICE, DECLARED])
    expect(replayed.steps[REVIEW].summary).toBe(state.steps[REVIEW].summary)
  })
})
