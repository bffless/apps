import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from './definition'
import { buildJobContexts, evalValue } from './contexts'
import { jobResult } from './graph'
import { initialRunState, runReducer } from './reducer'
import type { Definition, RunEvent, RunState } from './types'
import { stepKey } from './types'
import { nextActions, type NextAction } from './next'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

const step = (id: string) => ({ id, uses: 'pipeline', with: { path: 'echo' } })

/** `a` → `b`,`c` → `d`, one step each. */
const diamond: Definition = toDefinition({
  name: 'Diamond',
  jobs: {
    a: { steps: [step('s')] },
    b: { needs: 'a', steps: [step('s')] },
    c: { needs: 'a', steps: [step('s')] },
    d: { needs: ['b', 'c'], steps: [step('s')] },
  },
})

/** Three matrix items, one at a time, so a failure leaves two un-started. */
const failFast: Definition = toDefinition({
  name: 'FailFast',
  jobs: {
    m: {
      strategy: { matrix: { n: [1, 2, 3] }, 'max-parallel': 1 },
      steps: [step('s')],
    },
  },
})

/** A job switched off by `if`, and a job that needs it. */
const gated: Definition = toDefinition({
  name: 'Gated',
  jobs: {
    gate: {
      if: '${{ false }}',
      steps: [step('s1'), step('s2')],
      outputs: { v: '${{ steps.s1.outputs.x }}' },
    },
    dep: { needs: 'gate', steps: [step('t')] },
  },
})

// ---------------------------------------------------------------------------
// Event helpers — every scenario folds real events through the real reducer.
// ---------------------------------------------------------------------------

let clock = 1_000
const now = () => (clock += 1)

function startRun(inputs: Record<string, unknown> = {}): RunState {
  const seed = initialRunState({
    runId: 'run_TEST',
    impl: 'hello',
    workflow: 'hello',
    inputs: {},
    headless: false,
    startedAt: 0,
  })
  return runReducer(seed, {
    type: 'run.started',
    runId: 'run_TEST',
    impl: 'hello',
    workflow: 'hello',
    inputs,
    headless: false,
    at: now(),
  })
}

function fold(state: RunState, ...events: RunEvent[]): RunState {
  return events.reduce(runReducer, state)
}

function kindOf(def: Definition, job: string, stepId: string) {
  const found = def.jobs[job]?.steps.find((s) => s.id === stepId)
  if (!found) throw new Error(`no step ${job}/${stepId}`)
  return found.uses
}

/** Queue + start one step, leaving it in flight. */
function begin(def: Definition, state: RunState, job: string, index: number, stepId: string) {
  const key = stepKey(job, index, stepId)
  return fold(
    state,
    { type: 'step.queued', key, job, index, stepId, kind: kindOf(def, job, stepId), at: now() },
    { type: 'step.started', key, inputs: {}, at: now() },
  )
}

function succeed(state: RunState, key: string, outputs: Record<string, unknown> = {}) {
  return fold(state, { type: 'step.succeeded', key, outputs, at: now() })
}

function fail(state: RunState, key: string) {
  return fold(state, {
    type: 'step.failed',
    key,
    error: { code: 'BOOM', message: 'on purpose' },
    at: now(),
  })
}

/** Apply one scheduler action, driving each started step to a terminal state. */
function apply(
  def: Definition,
  state: RunState,
  action: NextAction,
  plan: { fails?: string[]; outputs?: Record<string, Record<string, unknown>> },
): RunState {
  switch (action.kind) {
    case 'expand':
      return fold(state, {
        type: 'job.expanded',
        job: action.job,
        total: action.total,
        items: action.items,
      })
    case 'skip':
      return fold(
        state,
        ...action.steps.map(
          (s): RunEvent => ({
            type: 'step.skipped',
            key: s.key,
            job: s.job,
            index: s.index,
            stepId: s.stepId,
            kind: s.stepKind,
            at: now(),
          }),
        ),
      )
    case 'start': {
      const next = begin(def, state, action.job, action.index, action.stepId)
      return plan.fails?.includes(action.key)
        ? fail(next, action.key)
        : succeed(next, action.key, plan.outputs?.[action.key] ?? {})
    }
    case 'finish':
      return fold(state, { type: 'run.finished', status: action.status, at: now() })
  }
}

/** Run the scheduler to a fixpoint, recording the actions proposed on each tick. */
function drive(
  def: Definition,
  state: RunState,
  plan: { fails?: string[]; outputs?: Record<string, Record<string, unknown>> } = {},
): { state: RunState; ticks: NextAction[][] } {
  const ticks: NextAction[][] = []
  for (let guard = 0; guard < 200; guard++) {
    const actions = nextActions(def, state)
    if (actions.length === 0) return { state, ticks }
    ticks.push(actions)
    for (const action of actions) state = apply(def, state, action, plan)
  }
  throw new Error('scheduler did not settle')
}

const flat = (ticks: NextAction[][]) => ticks.flat()
const startedKeys = (ticks: NextAction[][]) =>
  flat(ticks).flatMap((a) => (a.kind === 'start' ? [a.key] : []))
const skippedKeys = (ticks: NextAction[][]) =>
  flat(ticks).flatMap((a) => (a.kind === 'skip' ? a.steps.map((s) => s.key) : []))

// ---------------------------------------------------------------------------
// 1. Diamond DAG
// ---------------------------------------------------------------------------

describe('nextActions — diamond DAG', () => {
  it('expands only the root job at the start of the run', () => {
    expect(nextActions(diamond, startRun())).toEqual([
      { kind: 'expand', job: 'a', total: 1, items: [{}] },
    ])
  })

  it('starts the root step once the job is expanded', () => {
    let state = startRun()
    state = fold(state, { type: 'job.expanded', job: 'a', total: 1, items: [{}] })
    expect(nextActions(diamond, state)).toEqual([
      { kind: 'start', key: 'a/0/s', job: 'a', index: 0, stepId: 's' },
    ])
  })

  it('proposes nothing while a step is in flight', () => {
    let state = startRun()
    state = fold(state, { type: 'job.expanded', job: 'a', total: 1, items: [{}] })
    state = begin(diamond, state, 'a', 0, 's')
    expect(nextActions(diamond, state)).toEqual([])
  })

  it('fans out to both branches when the root succeeds, then waits for both', () => {
    let state = startRun()
    state = fold(state, { type: 'job.expanded', job: 'a', total: 1, items: [{}] })
    state = succeed(begin(diamond, state, 'a', 0, 's'), 'a/0/s')

    expect(nextActions(diamond, state)).toEqual([
      { kind: 'expand', job: 'b', total: 1, items: [{}] },
      { kind: 'expand', job: 'c', total: 1, items: [{}] },
    ])

    state = fold(
      state,
      { type: 'job.expanded', job: 'b', total: 1, items: [{}] },
      { type: 'job.expanded', job: 'c', total: 1, items: [{}] },
    )
    expect(nextActions(diamond, state)).toEqual([
      { kind: 'start', key: 'b/0/s', job: 'b', index: 0, stepId: 's' },
      { kind: 'start', key: 'c/0/s', job: 'c', index: 0, stepId: 's' },
    ])

    // Only one branch finishes: the join is not ready.
    state = begin(diamond, state, 'b', 0, 's')
    state = begin(diamond, state, 'c', 0, 's')
    state = succeed(state, 'b/0/s')
    expect(nextActions(diamond, state)).toEqual([])

    // Both branches done → the join expands, then starts exactly once.
    state = succeed(state, 'c/0/s')
    expect(nextActions(diamond, state)).toEqual([
      { kind: 'expand', job: 'd', total: 1, items: [{}] },
    ])
    state = fold(state, { type: 'job.expanded', job: 'd', total: 1, items: [{}] })
    expect(nextActions(diamond, state)).toEqual([
      { kind: 'start', key: 'd/0/s', job: 'd', index: 0, stepId: 's' },
    ])
  })

  it('drives the whole diamond to a successful finish, starting every step once', () => {
    const { ticks, state } = drive(diamond, startRun())
    expect(startedKeys(ticks)).toEqual(['a/0/s', 'b/0/s', 'c/0/s', 'd/0/s'])
    expect(flat(ticks).at(-1)).toEqual({ kind: 'finish', status: 'succeeded' })
    expect(state.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// 2. Matrix fan-in with max-parallel
// ---------------------------------------------------------------------------

describe('nextActions — matrix fan-in', () => {
  const inputs = { greeting: 'Hello', names: ['world', 'studio', 'reader'], shout: false }

  it('expands the matrix job over its list', () => {
    expect(nextActions(hello, startRun(inputs))).toEqual([
      {
        kind: 'expand',
        job: 'greet',
        total: 3,
        items: [{ who: 'world' }, { who: 'studio' }, { who: 'reader' }],
      },
    ])
  })

  it('starts only max-parallel items, and releases the next as one finishes', () => {
    let state = startRun(inputs)
    state = fold(state, {
      type: 'job.expanded',
      job: 'greet',
      total: 3,
      items: [{ who: 'world' }, { who: 'studio' }, { who: 'reader' }],
    })

    expect(nextActions(hello, state)).toEqual([
      { kind: 'start', key: 'greet/0/say', job: 'greet', index: 0, stepId: 'say' },
      { kind: 'start', key: 'greet/1/say', job: 'greet', index: 1, stepId: 'say' },
    ])

    state = begin(hello, state, 'greet', 0, 'say')
    state = begin(hello, state, 'greet', 1, 'say')
    expect(nextActions(hello, state)).toEqual([])

    state = succeed(state, 'greet/0/say', { line: 'Hello, world!' })
    expect(nextActions(hello, state)).toEqual([
      { kind: 'start', key: 'greet/2/say', job: 'greet', index: 2, stepId: 'say' },
    ])
  })

  it('collects the matrix outputs into a list, in matrix order, for the dependent jobs', () => {
    let state = startRun(inputs)
    state = fold(state, {
      type: 'job.expanded',
      job: 'greet',
      total: 3,
      items: [{ who: 'world' }, { who: 'studio' }, { who: 'reader' }],
    })
    for (const [i, who] of ['world', 'studio', 'reader'].entries()) {
      state = begin(hello, state, 'greet', i, 'say')
      state = succeed(state, `greet/${i}/say`, { line: `Hello, ${who}!` })
    }

    expect(jobResult(hello, state, 'greet')).toBe('success')
    expect(nextActions(hello, state)).toEqual([
      { kind: 'expand', job: 'flaky', total: 1, items: [{}] },
      { kind: 'expand', job: 'slow', total: 1, items: [{}] },
    ])

    const ctx = buildJobContexts(hello, state, 'slow')
    expect(evalValue('${{ needs.greet.outputs.lines }}', ctx)).toEqual([
      'Hello, world!',
      'Hello, studio!',
      'Hello, reader!',
    ])
  })
})

// ---------------------------------------------------------------------------
// 3. fail-fast
// ---------------------------------------------------------------------------

describe('nextActions — fail-fast', () => {
  it('skips the un-started matrix items after one fails, and the job result is failure', () => {
    let state = startRun()
    state = fold(state, {
      type: 'job.expanded',
      job: 'm',
      total: 3,
      items: [{ n: 1 }, { n: 2 }, { n: 3 }],
    })
    state = begin(failFast, state, 'm', 0, 's')
    expect(jobResult(failFast, state, 'm')).toBe('running')

    state = fail(state, 'm/0/s')
    expect(nextActions(failFast, state)).toEqual([
      {
        kind: 'skip',
        steps: [
          { key: 'm/1/s', job: 'm', index: 1, stepId: 's', stepKind: 'pipeline' },
          { key: 'm/2/s', job: 'm', index: 2, stepId: 's', stepKind: 'pipeline' },
        ],
      },
    ])

    state = apply(failFast, state, nextActions(failFast, state)[0], {})
    expect(jobResult(failFast, state, 'm')).toBe('failure')
    expect(nextActions(failFast, state)).toEqual([{ kind: 'finish', status: 'failed' }])
  })

  it('keeps going through the remaining items when fail-fast is off', () => {
    const def = toDefinition({
      name: 'NoFailFast',
      jobs: {
        m: {
          strategy: { matrix: { n: [1, 2, 3] }, 'max-parallel': 1, 'fail-fast': false },
          steps: [step('s')],
        },
      },
    })
    const { ticks, state } = drive(def, startRun(), { fails: ['m/0/s'] })
    expect(startedKeys(ticks)).toEqual(['m/0/s', 'm/1/s', 'm/2/s'])
    expect(skippedKeys(ticks)).toEqual([])
    expect(jobResult(def, state, 'm')).toBe('failure')
    expect(state.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// 4 + 6. continue-on-error and the failure() path (hello's `flaky`)
// ---------------------------------------------------------------------------

describe('nextActions — continue-on-error and the failure() path', () => {
  const inputs = { greeting: 'Hello', names: ['world'], shout: false }

  it('continues the item past a tolerated failure and still runs the failure()-gated step', () => {
    const { ticks, state } = drive(hello, startRun(inputs), { fails: ['flaky/0/boom'] })

    expect(startedKeys(ticks)).toContain('flaky/0/boom')
    // `after` is gated on `steps.boom.outcome == 'failure'` — it runs.
    expect(startedKeys(ticks)).toContain('flaky/0/after')
    expect(skippedKeys(ticks)).not.toContain('flaky/0/after')
    // continue-on-error ⇒ the job (and the run) still succeed.
    expect(jobResult(hello, state, 'flaky')).toBe('success')
    expect(state.status).toBe('succeeded')
  })

  it('skips the failure()-gated step when the tolerated step succeeds', () => {
    const { ticks, state } = drive(hello, startRun(inputs))

    expect(startedKeys(ticks)).toContain('flaky/0/boom')
    expect(startedKeys(ticks)).not.toContain('flaky/0/after')
    expect(skippedKeys(ticks)).toContain('flaky/0/after')
    expect(jobResult(hello, state, 'flaky')).toBe('success')
  })

  it('skips the remaining default-if steps of an item once a step fails untolerated', () => {
    const def = toDefinition({
      name: 'Sequence',
      jobs: {
        j: {
          steps: [
            step('s1'),
            step('s2'),
            { id: 'always', uses: 'pipeline', if: 'always()', with: { path: 'echo' } },
          ],
        },
      },
    })
    const { ticks, state } = drive(def, startRun(), { fails: ['j/0/s1'] })
    expect(startedKeys(ticks)).toEqual(['j/0/s1', 'j/0/always'])
    expect(skippedKeys(ticks)).toEqual(['j/0/s2'])
    expect(jobResult(def, state, 'j')).toBe('failure')
    expect(state.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// 5. skipped-by-if, and the dependent of a skipped job
// ---------------------------------------------------------------------------

describe('nextActions — skipped by if', () => {
  it('gives every step of an if-false job a skip row, and skips its dependent too', () => {
    let state = startRun()

    // The job is expanded first (the record needs a row per matrix item).
    expect(nextActions(gated, state)).toEqual([
      { kind: 'expand', job: 'gate', total: 1, items: [{}] },
    ])
    state = apply(gated, state, nextActions(gated, state)[0], {})

    expect(nextActions(gated, state)).toEqual([
      {
        kind: 'skip',
        steps: [
          { key: 'gate/0/s1', job: 'gate', index: 0, stepId: 's1', stepKind: 'pipeline' },
          { key: 'gate/0/s2', job: 'gate', index: 0, stepId: 's2', stepKind: 'pipeline' },
        ],
      },
    ])
    state = apply(gated, state, nextActions(gated, state)[0], {})
    expect(jobResult(gated, state, 'gate')).toBe('skipped')

    // A skipped need does not satisfy `needs`: the dependent is skipped too.
    state = apply(gated, state, nextActions(gated, state)[0], {}) // expand dep
    expect(nextActions(gated, state)).toEqual([
      {
        kind: 'skip',
        steps: [{ key: 'dep/0/t', job: 'dep', index: 0, stepId: 't', stepKind: 'pipeline' }],
      },
    ])
    state = apply(gated, state, nextActions(gated, state)[0], {})
    expect(jobResult(gated, state, 'dep')).toBe('skipped')

    // …and the skipped job's outputs read as null.
    expect(evalValue('${{ needs.gate.outputs.v }}', buildJobContexts(gated, state, 'dep'))).toBeNull()

    // Skipped is not failed: the run succeeds.
    expect(nextActions(gated, state)).toEqual([{ kind: 'finish', status: 'succeeded' }])
  })

  it('runs a dependent that opts in with always()', () => {
    const def = toDefinition({
      name: 'AlwaysDep',
      jobs: {
        gate: { if: '${{ false }}', steps: [step('s')] },
        dep: { needs: 'gate', if: 'always()', steps: [step('t')] },
      },
    })
    const { ticks, state } = drive(def, startRun())
    expect(skippedKeys(ticks)).toContain('gate/0/s')
    expect(startedKeys(ticks)).toContain('dep/0/t')
    expect(state.status).toBe('succeeded')
  })

  it('never proposes a step that already has state', () => {
    const { ticks } = drive(gated, startRun())
    const keys = [...startedKeys(ticks), ...skippedKeys(ticks)]
    expect(new Set(keys).size).toBe(keys.length)
  })
})

// ---------------------------------------------------------------------------
// 7. Finishing
// ---------------------------------------------------------------------------

describe('nextActions — finishing', () => {
  it('finishes failed when any job failed', () => {
    const { ticks, state } = drive(diamond, startRun(), { fails: ['b/0/s'] })
    expect(flat(ticks).at(-1)).toEqual({ kind: 'finish', status: 'failed' })
    expect(jobResult(diamond, state, 'b')).toBe('failure')
    // `d` needs `b`: a failed need does not satisfy `needs`, so `d` is skipped.
    expect(jobResult(diamond, state, 'd')).toBe('skipped')
    expect(state.status).toBe('failed')
  })

  it('finishes succeeded when every job succeeded or was skipped', () => {
    const { ticks } = drive(gated, startRun())
    expect(flat(ticks).at(-1)).toEqual({ kind: 'finish', status: 'succeeded' })
  })

  it('proposes nothing once the run is finished', () => {
    const { state } = drive(diamond, startRun())
    expect(state.status).toBe('succeeded')
    expect(nextActions(diamond, state)).toEqual([])
  })

  it('proposes nothing for a cancelled run', () => {
    let state = startRun()
    state = fold(state, { type: 'run.finished', status: 'cancelled', at: now() })
    expect(nextActions(diamond, state)).toEqual([])
  })
})
