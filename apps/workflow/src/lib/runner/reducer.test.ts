import { describe, expect, it } from 'vitest'
import type { RunEvent, RunState } from './types'
import { stepKey } from './types'
import { IllegalTransition } from './transitions'
import { initialRunState, runReducer } from './reducer'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN_ID = 'run_TEST'
const KEY = stepKey('a', 0, 's1')

function started(over: Partial<Extract<RunEvent, { type: 'run.started' }>> = {}): RunEvent {
  return {
    type: 'run.started',
    runId: RUN_ID,
    impl: 'hello',
    workflow: 'hello',
    inputs: { greeting: 'Hello' },
    headless: false,
    at: 1_000,
    ...over,
  }
}

function queued(over: Partial<Extract<RunEvent, { type: 'step.queued' }>> = {}): RunEvent {
  return {
    type: 'step.queued',
    key: KEY,
    job: 'a',
    index: 0,
    stepId: 's1',
    kind: 'pipeline',
    at: 1_001,
    ...over,
  }
}

/** run.started -> step.queued, the common baseline every scenario below builds on. */
function baseline(): RunState {
  let state = runReducer(initialRunState({ runId: 'x', impl: 'x', workflow: 'x', inputs: {}, headless: false, startedAt: 0 }), started())
  state = runReducer(state, queued())
  return state
}

// ---------------------------------------------------------------------------
// initialRunState
// ---------------------------------------------------------------------------

describe('initialRunState', () => {
  it('fills every non-optional RunState field', () => {
    const state = initialRunState({
      runId: RUN_ID,
      impl: 'hello',
      workflow: 'hello',
      inputs: { greeting: 'Hi' },
      headless: true,
      startedAt: 42,
    })
    expect(state).toEqual({
      runId: RUN_ID,
      impl: 'hello',
      workflow: 'hello',
      status: 'running',
      headless: true,
      // Absent from the args above — an older row's `run.started` — so it reads `false` (07).
      unattended: false,
      inputs: { greeting: 'Hi' },
      steps: {},
      expansions: {},
      annotations: [],
      startedAt: 42,
    })
  })
})

// ---------------------------------------------------------------------------
// run.started
// ---------------------------------------------------------------------------

describe('run.started', () => {
  it('builds initialRunState regardless of the prior state', () => {
    const prior = initialRunState({ runId: 'stale', impl: 'x', workflow: 'x', inputs: {}, headless: false, startedAt: 0 })
    const next = runReducer(prior, started())
    expect(next).toEqual(
      initialRunState({
        runId: RUN_ID,
        impl: 'hello',
        workflow: 'hello',
        inputs: { greeting: 'Hello' },
        headless: false,
        startedAt: 1_000,
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Full happy lifecycle: queued -> running -> polling -> succeeded
// ---------------------------------------------------------------------------

describe('happy pipeline lifecycle', () => {
  it('queued -> running -> polling -> succeeded, asserting payload at each hop', () => {
    let state = baseline()
    expect(state.steps[KEY]).toMatchObject({ status: 'queued', attempt: 1, annotations: [] })

    state = runReducer(state, { type: 'step.started', key: KEY, inputs: { path: 'echo' }, at: 1_002 })
    expect(state.steps[KEY]).toMatchObject({
      status: 'running',
      inputs: { path: 'echo' },
      startedAt: 1_002,
    })

    state = runReducer(state, { type: 'step.polling', key: KEY, initial: { jobId: 'j1' }, at: 1_003 })
    expect(state.steps[KEY]).toMatchObject({
      status: 'polling',
      response: { initial: { jobId: 'j1' } },
    })

    state = runReducer(state, {
      type: 'step.succeeded',
      key: KEY,
      outputs: { x: 'ok' },
      response: { initial: { jobId: 'j1' }, last: { done: true }, truncated: false },
      summary: 'Done',
      annotations: [{ level: 'notice', message: 'all good' }],
      at: 1_004,
    })
    expect(state.steps[KEY]).toMatchObject({
      status: 'succeeded',
      outputs: { x: 'ok' },
      response: { initial: { jobId: 'j1' }, last: { done: true }, truncated: false },
      summary: 'Done',
      annotations: [{ level: 'notice', message: 'all good' }],
      finishedAt: 1_004,
    })
  })
})

// ---------------------------------------------------------------------------
// Retry cycle: running/polling -> queued via step.retrying, then queued -> running
// ---------------------------------------------------------------------------

describe('retry cycle', () => {
  it('running -> queued via step.retrying increments attempt and keeps the error, then queued -> running again', () => {
    let state = baseline()
    state = runReducer(state, { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
    expect(state.steps[KEY].attempt).toBe(1)

    const retryError = { code: 'ETIMEDOUT', message: 'timed out' }
    state = runReducer(state, { type: 'step.retrying', key: KEY, error: retryError, at: 1_003 })
    expect(state.steps[KEY]).toMatchObject({ status: 'queued', attempt: 2, error: retryError })

    state = runReducer(state, { type: 'step.started', key: KEY, inputs: { path: 'echo' }, at: 1_004 })
    expect(state.steps[KEY]).toMatchObject({
      status: 'running',
      attempt: 2,
      error: retryError, // kept "for the pane" per the brief
      inputs: { path: 'echo' },
      startedAt: 1_004,
    })
  })

  it('polling -> queued via step.retrying increments attempt', () => {
    let state = baseline()
    state = runReducer(state, { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
    state = runReducer(state, { type: 'step.polling', key: KEY, initial: { jobId: 'j1' }, at: 1_003 })

    const retryError = { code: 'E502', message: 'bad gateway' }
    state = runReducer(state, { type: 'step.retrying', key: KEY, error: retryError, at: 1_004 })
    expect(state.steps[KEY]).toMatchObject({ status: 'queued', attempt: 2, error: retryError })
  })
})

// ---------------------------------------------------------------------------
// Form step: queued -> waiting -> succeeded
// ---------------------------------------------------------------------------

describe('form step lifecycle', () => {
  it('queued -> waiting -> succeeded', () => {
    let state = baseline()
    state = runReducer(state, { type: 'step.waiting', key: KEY, at: 1_002 })
    expect(state.steps[KEY].status).toBe('waiting')

    state = runReducer(state, {
      type: 'step.succeeded',
      key: KEY,
      outputs: { confirmed: true },
      at: 1_003,
    })
    expect(state.steps[KEY]).toMatchObject({ status: 'succeeded', outputs: { confirmed: true } })
  })

  // Task 9: the wait clock measures its `timeout-minutes` budget from here, and
  // a form emits no `step.started` to stamp it.
  it('step.waiting stamps startedAt when the step never ran (a form)', () => {
    const state = runReducer(baseline(), {
      type: 'step.waiting',
      key: KEY,
      inputs: { title: 'Approve?' },
      at: 1_002,
    })
    expect(state.steps[KEY].startedAt).toBe(1_002)
  })

  it('step.waiting keeps the startedAt a running step already has (an island)', () => {
    let state = runReducer(baseline(), { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
    state = runReducer(state, { type: 'step.waiting', key: KEY, at: 1_009 })
    // An island is `running` while it loads: the wait began when it did, and a
    // re-emitted `step.waiting` (Resume) must not move it either.
    expect(state.steps[KEY].startedAt).toBe(1_002)
    state = runReducer(state, { type: 'step.waiting', key: KEY, at: 1_050 })
    expect(state.steps[KEY].startedAt).toBe(1_002)
  })
})

// ---------------------------------------------------------------------------
// Same-status re-emission: polling -> polling refreshes the payload
// ---------------------------------------------------------------------------

describe('same-status re-emission', () => {
  it('polling -> polling is accepted and refreshes the payload', () => {
    let state = baseline()
    state = runReducer(state, { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
    state = runReducer(state, { type: 'step.polling', key: KEY, initial: { jobId: 'j1' }, at: 1_003 })

    const next = runReducer(state, { type: 'step.polling', key: KEY, initial: { jobId: 'j1', resumed: true }, at: 1_004 })
    expect(next.steps[KEY]).toMatchObject({
      status: 'polling',
      response: { initial: { jobId: 'j1', resumed: true } },
    })
  })
})

// ---------------------------------------------------------------------------
// Illegal transitions throw
// ---------------------------------------------------------------------------

describe('illegal transitions', () => {
  it('succeeded -> running throws IllegalTransition', () => {
    let state = baseline()
    state = runReducer(state, { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
    state = runReducer(state, { type: 'step.succeeded', key: KEY, outputs: {}, at: 1_003 })

    expect(() => runReducer(state, { type: 'step.started', key: KEY, inputs: {}, at: 1_004 })).toThrow(
      IllegalTransition,
    )
  })

  it('step.started on an unknown key throws', () => {
    const state = baseline()
    expect(() =>
      runReducer(state, { type: 'step.started', key: stepKey('a', 0, 'nope'), inputs: {}, at: 1_002 }),
    ).toThrow()
  })

  it('step.queued on an existing succeeded step throws IllegalTransition, without wiping it', () => {
    let state = baseline()
    state = runReducer(state, { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
    state = runReducer(state, {
      type: 'step.succeeded',
      key: KEY,
      outputs: { x: 'ok' },
      at: 1_003,
    })

    expect(() => runReducer(state, queued())).toThrow(IllegalTransition)
    // A rejected duplicate must not have mutated the state it was rejected against.
    expect(state.steps[KEY]).toMatchObject({ status: 'succeeded', outputs: { x: 'ok' } })
  })

  it('step.skipped on an existing running step throws IllegalTransition, without wiping it', () => {
    let state = baseline()
    state = runReducer(state, { type: 'step.started', key: KEY, inputs: { path: 'echo' }, at: 1_002 })

    expect(() =>
      runReducer(state, {
        type: 'step.skipped',
        key: KEY,
        job: 'a',
        index: 0,
        stepId: 's1',
        kind: 'pipeline',
        at: 1_003,
      }),
    ).toThrow(IllegalTransition)
    expect(state.steps[KEY]).toMatchObject({ status: 'running', inputs: { path: 'echo' } })
  })
})

// ---------------------------------------------------------------------------
// run.finished
// ---------------------------------------------------------------------------

describe('run.finished', () => {
  it('stamps run status, outputs, and finishedAt', () => {
    const state = baseline()
    const next = runReducer(state, {
      type: 'run.finished',
      status: 'succeeded',
      outputs: { all: 'done' },
      at: 2_000,
    })
    expect(next.status).toBe('succeeded')
    expect(next.outputs).toEqual({ all: 'done' })
    expect(next.finishedAt).toBe(2_000)
  })
})

// ---------------------------------------------------------------------------
// run.annotation
// ---------------------------------------------------------------------------

describe('run.annotation', () => {
  it('appends to state.annotations', () => {
    const state = baseline()
    const next = runReducer(state, {
      type: 'run.annotation',
      annotation: { level: 'warning', message: 'heads up' },
      at: 1_500,
    })
    expect(next.annotations).toEqual([{ level: 'warning', message: 'heads up' }])
  })
})

// ---------------------------------------------------------------------------
// step.annotated (Decision 12) — an in-place update, not a status transition
// ---------------------------------------------------------------------------

describe('step.annotated', () => {
  /** queued -> waiting: an island/form step parked on a human. */
  function waiting(): RunState {
    return runReducer(baseline(), { type: 'step.waiting', key: KEY, at: 1_002 })
  }

  it('appends annotations to a waiting step without changing its status', () => {
    let state = waiting()
    state = runReducer(state, {
      type: 'step.annotated',
      key: KEY,
      annotations: [{ level: 'notice', message: 'first' }],
      at: 1_003,
    })
    state = runReducer(state, {
      type: 'step.annotated',
      key: KEY,
      annotations: [{ level: 'warning', message: 'second' }],
      at: 1_004,
    })

    expect(state.steps[KEY].status).toBe('waiting')
    expect(state.steps[KEY].annotations).toEqual([
      { level: 'notice', message: 'first' },
      { level: 'warning', message: 'second' },
    ])
  })

  it('replaces the summary when one is given, and keeps it when one is not', () => {
    let state = waiting()
    state = runReducer(state, { type: 'step.annotated', key: KEY, summary: 'half', at: 1_003 })
    expect(state.steps[KEY].summary).toBe('half')

    state = runReducer(state, { type: 'step.annotated', key: KEY, summary: 'most', at: 1_004 })
    expect(state.steps[KEY].summary).toBe('most')

    state = runReducer(state, {
      type: 'step.annotated',
      key: KEY,
      annotations: [{ level: 'notice', message: 'm' }],
      at: 1_005,
    })
    expect(state.steps[KEY].summary).toBe('most')
  })

  it('survives the step finishing: a terminal event appends, it does not replace', () => {
    const a = { level: 'notice' as const, message: 'previewed' }
    const b = { level: 'notice' as const, message: 'declared' }

    let state = waiting()
    state = runReducer(state, { type: 'step.annotated', key: KEY, annotations: [a], at: 1_003 })

    const succeeded = runReducer(state, {
      type: 'step.succeeded',
      key: KEY,
      outputs: {},
      annotations: [b],
      at: 1_004,
    })
    expect(succeeded.steps[KEY].annotations).toEqual([a, b])

    // A step that declares none evaluates to `[]` — which must keep, not wipe.
    const bare = runReducer(state, {
      type: 'step.succeeded',
      key: KEY,
      outputs: {},
      annotations: [],
      at: 1_004,
    })
    expect(bare.steps[KEY].annotations).toEqual([a])

    const failed = runReducer(state, {
      type: 'step.failed',
      key: KEY,
      error: { code: 'X', message: 'x' },
      annotations: [b],
      at: 1_004,
    })
    expect(failed.steps[KEY].annotations).toEqual([a, b])
  })

  it('is cleared by a retry: a fresh attempt starts with no progress notes', () => {
    let state = runReducer(baseline(), { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
    state = runReducer(state, {
      type: 'step.annotated',
      key: KEY,
      annotations: [{ level: 'notice', message: 'attempt 1 got half way' }],
      summary: 'half',
      at: 1_003,
    })

    state = runReducer(state, {
      type: 'step.retrying',
      key: KEY,
      error: { code: 'HTTP_503', message: 'busy' },
      at: 1_004,
    })

    expect(state.steps[KEY]).toMatchObject({ status: 'queued', attempt: 2 })
    expect(state.steps[KEY].annotations).toEqual([])
    expect(state.steps[KEY].summary).toBeUndefined()
    // The failure itself is what survives a retry.
    expect(state.steps[KEY].error).toEqual({ code: 'HTTP_503', message: 'busy' })
  })

  it.each(['running', 'polling', 'waiting'] as const)('is legal while %s', (status) => {
    let state = baseline()
    if (status === 'waiting') {
      state = runReducer(state, { type: 'step.waiting', key: KEY, at: 1_002 })
    } else {
      state = runReducer(state, { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
      if (status === 'polling') {
        state = runReducer(state, { type: 'step.polling', key: KEY, initial: null, at: 1_003 })
      }
    }

    const next = runReducer(state, {
      type: 'step.annotated',
      key: KEY,
      annotations: [{ level: 'notice', message: 'm' }],
      at: 1_004,
    })
    expect(next.steps[KEY].status).toBe(status)
    expect(next.steps[KEY].annotations).toHaveLength(1)
  })

  it.each(['queued', 'succeeded', 'failed', 'cancelled'] as const)(
    'throws IllegalTransition on a %s step',
    (status) => {
      let state = baseline()
      if (status === 'succeeded') {
        state = runReducer(state, { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
        state = runReducer(state, { type: 'step.succeeded', key: KEY, outputs: {}, at: 1_003 })
      } else if (status === 'failed') {
        state = runReducer(state, { type: 'step.started', key: KEY, inputs: {}, at: 1_002 })
        state = runReducer(state, {
          type: 'step.failed',
          key: KEY,
          error: { code: 'X', message: 'x' },
          at: 1_003,
        })
      } else if (status === 'cancelled') {
        state = runReducer(state, { type: 'step.cancelled', key: KEY, at: 1_002 })
      }

      expect(state.steps[KEY].status).toBe(status)
      expect(() =>
        runReducer(state, {
          type: 'step.annotated',
          key: KEY,
          annotations: [{ level: 'notice', message: 'm' }],
          at: 1_004,
        }),
      ).toThrow(IllegalTransition)
    },
  )
})

// ---------------------------------------------------------------------------
// job.expanded and step.skipped, exercised for reducer completeness
// ---------------------------------------------------------------------------

describe('job.expanded', () => {
  it('fills expansions[job]', () => {
    const state = baseline()
    const next = runReducer(state, {
      type: 'job.expanded',
      job: 'a',
      total: 2,
      items: [{ name: 'x' }, { name: 'y' }],
    })
    expect(next.expansions.a).toEqual({ total: 2, items: [{ name: 'x' }, { name: 'y' }] })
  })
})

describe('step.skipped', () => {
  it('creates a terminal StepState', () => {
    const state = baseline()
    const skipKey = stepKey('a', 0, 's2')
    const next = runReducer(state, {
      type: 'step.skipped',
      key: skipKey,
      job: 'a',
      index: 0,
      stepId: 's2',
      kind: 'pipeline',
      at: 1_002,
    })
    expect(next.steps[skipKey]).toMatchObject({ status: 'skipped', attempt: 1, annotations: [] })
    expect(next.steps[skipKey].outputs).toBeUndefined()
  })

  // Task 12: a `headless: skip` stands the step's declared outputs in for the
  // work it never did, so downstream expressions read them like any other
  // step's. A scheduler skip (`if:` false, a failed need) carries none.
  it('keeps the outputs a headless skip stood in for', () => {
    const state = baseline()
    const skipKey = stepKey('a', 0, 's2')
    const next = runReducer(state, {
      type: 'step.skipped',
      key: skipKey,
      job: 'a',
      index: 0,
      stepId: 's2',
      kind: 'form',
      outputs: { approved: true },
      at: 1_002,
    })
    expect(next.steps[skipKey]).toMatchObject({
      status: 'skipped',
      outputs: { approved: true },
    })
  })
})

// ---------------------------------------------------------------------------
// Immutability: prior state objects are never mutated, and untouched
// subtrees are shared by reference (structural sharing).
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('does not mutate the input state and shares untouched references', () => {
    const otherKey = stepKey('a', 0, 's2')
    let state = baseline()
    state = runReducer(state, queued({ key: otherKey, stepId: 's2' }))

    const before = state
    const beforeSteps = state.steps
    const beforeOtherStep = state.steps[otherKey]
    const beforeAnnotations = state.annotations

    const after = runReducer(state, { type: 'step.started', key: KEY, inputs: { a: 1 }, at: 1_002 })

    // Input state object is untouched.
    expect(before.steps[KEY].status).toBe('queued')
    expect(before).toBe(state)
    expect(state.steps).toBe(beforeSteps)

    // A new state object was returned.
    expect(after).not.toBe(before)
    expect(after.steps).not.toBe(beforeSteps)

    // Untouched step and untouched annotations array are shared by reference.
    expect(after.steps[otherKey]).toBe(beforeOtherStep)
    expect(after.annotations).toBe(beforeAnnotations)
  })
})
