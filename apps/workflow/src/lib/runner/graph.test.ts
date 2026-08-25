import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from './definition'
import { buildJobContexts, evalValue } from './contexts'
import type { Definition, RunState, StepState } from './types'
import { stepKey } from './types'
import {
  expandMatrix,
  firstStepWhere,
  isTerminal,
  jobOrder,
  jobResult,
  needsEdges,
  refsIn,
  topoLayers,
} from './graph'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

const step = (id: string) => ({ id, uses: 'pipeline', with: { path: 'echo' } })

/** `a` → `b`,`c` → `d`. */
const diamond: Definition = toDefinition({
  name: 'Diamond',
  jobs: {
    a: { steps: [step('s')] },
    b: { needs: 'a', steps: [step('s')] },
    c: { needs: 'a', steps: [step('s')] },
    d: { needs: ['b', 'c'], steps: [step('s')] },
  },
})

/** One job, two steps; `s1` tolerates failure. */
const pair: Definition = toDefinition({
  name: 'Pair',
  jobs: {
    j: {
      steps: [
        { id: 's1', uses: 'pipeline', 'continue-on-error': true, with: { path: 'echo' } },
        step('s2'),
      ],
    },
  },
})

function makeState(over: Partial<RunState> = {}): RunState {
  return {
    runId: 'run_TEST',
    impl: 'hello',
    workflow: 'hello',
    status: 'running',
    headless: false,
    inputs: { greeting: 'Hello', names: ['world', 'studio', 'reader'], shout: false },
    steps: {},
    expansions: {},
    annotations: [],
    startedAt: 1_000,
    ...over,
  }
}

function stepState(
  job: string,
  index: number,
  stepId: string,
  over: Partial<StepState> = {},
): StepState {
  return {
    key: stepKey(job, index, stepId),
    job,
    index,
    stepId,
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 1,
    annotations: [],
    ...over,
  }
}

function withSteps(state: RunState, ...list: StepState[]): RunState {
  const steps = { ...state.steps }
  for (const s of list) steps[s.key] = s
  return { ...state, steps }
}

// ---------------------------------------------------------------------------
// topoLayers
// ---------------------------------------------------------------------------

describe('topoLayers', () => {
  it('lays a diamond out as left→right columns', () => {
    expect(topoLayers(diamond)).toEqual([['a'], ['b', 'c'], ['d']])
  })

  it('lays the hello workflow out in dependency order', () => {
    expect(topoLayers(hello)).toEqual([['greet'], ['flaky', 'slow'], ['confirm']])
  })

  it('puts independent jobs in one layer, ordered by job id', () => {
    const def = toDefinition({
      name: 'Wide',
      jobs: { zebra: { steps: [step('s')] }, apple: { steps: [step('s')] } },
    })
    expect(topoLayers(def)).toEqual([['apple', 'zebra']])
  })

  it('throws on a cycle', () => {
    const def = toDefinition({
      name: 'Cycle',
      jobs: {
        a: { needs: 'b', steps: [step('s')] },
        b: { needs: 'a', steps: [step('s')] },
      },
    })
    expect(() => topoLayers(def)).toThrow(/cycle/i)
  })

  it('throws when a job needs itself', () => {
    const def = toDefinition({ name: 'Self', jobs: { a: { needs: 'a', steps: [step('s')] } } })
    expect(() => topoLayers(def)).toThrow(/cycle/i)
  })

  it('ignores a need that names no job in this workflow (a lint error, not a schedule stop)', () => {
    const def = toDefinition({ name: 'Dangling', jobs: { a: { needs: 'ghost', steps: [step('s')] } } })
    expect(topoLayers(def)).toEqual([['a']])
  })
})

// ---------------------------------------------------------------------------
// needsEdges
// ---------------------------------------------------------------------------

describe('needsEdges', () => {
  it('emits one edge per need, pointing need → dependent', () => {
    expect(needsEdges(diamond)).toEqual([
      { fromJob: 'a', toJob: 'b', kind: 'needs' },
      { fromJob: 'a', toJob: 'c', kind: 'needs' },
      { fromJob: 'b', toJob: 'd', kind: 'needs' },
      { fromJob: 'c', toJob: 'd', kind: 'needs' },
    ])
  })

  it('drops edges to jobs that do not exist', () => {
    const def = toDefinition({ name: 'Dangling', jobs: { a: { needs: 'ghost', steps: [step('s')] } } })
    expect(needsEdges(def)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// expandMatrix
// ---------------------------------------------------------------------------

describe('expandMatrix', () => {
  it('expands a non-matrix job to a single empty item', () => {
    expect(expandMatrix(diamond.jobs.a, {})).toEqual({ total: 1, items: [{}] })
  })

  it('expands one variable from an expression, in list order', () => {
    const ctx = buildJobContexts(hello, makeState(), 'greet')
    expect(expandMatrix(hello.jobs.greet, ctx)).toEqual({
      total: 3,
      items: [{ who: 'world' }, { who: 'studio' }, { who: 'reader' }],
    })
  })

  it('expands a literal list', () => {
    const def = toDefinition({
      name: 'Lit',
      jobs: { m: { strategy: { matrix: { n: [1, 2, 3] } }, steps: [step('s')] } },
    })
    expect(expandMatrix(def.jobs.m, {})).toEqual({
      total: 3,
      items: [{ n: 1 }, { n: 2 }, { n: 3 }],
    })
  })

  it('takes the cartesian product of two variables, last varying fastest', () => {
    const def = toDefinition({
      name: 'Combo',
      jobs: { m: { strategy: { matrix: { a: [1, 2], b: ['x', 'y'] } }, steps: [step('s')] } },
    })
    expect(expandMatrix(def.jobs.m, {})).toEqual({
      total: 4,
      items: [
        { a: 1, b: 'x' },
        { a: 1, b: 'y' },
        { a: 2, b: 'x' },
        { a: 2, b: 'y' },
      ],
    })
  })

  it('expands a null or empty variable to zero items', () => {
    const ctx = buildJobContexts(hello, makeState({ inputs: {} }), 'greet')
    expect(expandMatrix(hello.jobs.greet, ctx)).toEqual({ total: 0, items: [] })
  })
})

// ---------------------------------------------------------------------------
// jobResult
// ---------------------------------------------------------------------------

describe('jobResult', () => {
  it('is pending before the job is expanded', () => {
    expect(jobResult(diamond, makeState(), 'a')).toBe('pending')
    expect(isTerminal('pending')).toBe(false)
  })

  it('is running once expanded but before the steps exist', () => {
    const state = makeState({ expansions: { a: { total: 1, items: [{}] } } })
    expect(jobResult(diamond, state, 'a')).toBe('running')
  })

  it('is running while a step is still in flight', () => {
    const state = withSteps(
      makeState({ expansions: { a: { total: 1, items: [{}] } } }),
      stepState('a', 0, 's', { status: 'running' }),
    )
    expect(jobResult(diamond, state, 'a')).toBe('running')
  })

  it('is running while a later matrix item has not been reached', () => {
    const state = withSteps(
      makeState({ expansions: { greet: { total: 3, items: [{}, {}, {}] } } }),
      stepState('greet', 0, 'say'),
      stepState('greet', 1, 'say'),
    )
    expect(jobResult(hello, state, 'greet')).toBe('running')
  })

  it('is running while a later step of the item has not been reached', () => {
    const state = withSteps(
      makeState({ expansions: { j: { total: 1, items: [{}] } } }),
      stepState('j', 0, 's1'),
    )
    expect(jobResult(pair, state, 'j')).toBe('running')
  })

  it('is success when every step of every item succeeded', () => {
    const state = withSteps(
      makeState({ expansions: { greet: { total: 2, items: [{}, {}] } } }),
      stepState('greet', 0, 'say'),
      stepState('greet', 1, 'say'),
    )
    expect(jobResult(hello, state, 'greet')).toBe('success')
    expect(isTerminal('success')).toBe(true)
  })

  it('is failure when a step failed without continue-on-error', () => {
    const state = withSteps(
      makeState({ expansions: { j: { total: 1, items: [{}] } } }),
      stepState('j', 0, 's1'),
      stepState('j', 0, 's2', { status: 'failed', error: { code: 'BOOM', message: 'x' } }),
    )
    expect(jobResult(pair, state, 'j')).toBe('failure')
  })

  it('is success when the only failure was tolerated by continue-on-error', () => {
    const state = withSteps(
      makeState({ expansions: { j: { total: 1, items: [{}] } } }),
      stepState('j', 0, 's1', { status: 'failed', error: { code: 'BOOM', message: 'x' } }),
      stepState('j', 0, 's2'),
    )
    expect(jobResult(pair, state, 'j')).toBe('success')
  })

  it('ranks failure above cancelled (fail-fast leaves both)', () => {
    const state = withSteps(
      makeState({ expansions: { greet: { total: 2, items: [{}, {}] } } }),
      stepState('greet', 0, 'say', { status: 'failed', error: { code: 'BOOM', message: 'x' } }),
      stepState('greet', 1, 'say', { status: 'cancelled' }),
    )
    expect(jobResult(hello, state, 'greet')).toBe('failure')
  })

  it('is cancelled when steps were cancelled and none failed', () => {
    const state = withSteps(
      makeState({ expansions: { greet: { total: 1, items: [{}] } } }),
      stepState('greet', 0, 'say', { status: 'cancelled' }),
    )
    expect(jobResult(hello, state, 'greet')).toBe('cancelled')
  })

  it('is skipped when every step was skipped', () => {
    const state = withSteps(
      makeState({ expansions: { j: { total: 1, items: [{}] } } }),
      stepState('j', 0, 's1', { status: 'skipped' }),
      stepState('j', 0, 's2', { status: 'skipped' }),
    )
    expect(jobResult(pair, state, 'j')).toBe('skipped')
  })

  it('is skipped when a matrix expanded to zero items', () => {
    const state = makeState({ expansions: { greet: { total: 0, items: [] } } })
    expect(jobResult(hello, state, 'greet')).toBe('skipped')
  })

  it('agrees with needs.<job>.result — one implementation, not two', () => {
    const cases: RunState[] = [
      withSteps(
        makeState({ expansions: { greet: { total: 1, items: [{ who: 'world' }] } } }),
        stepState('greet', 0, 'say'),
      ),
      withSteps(
        makeState({ expansions: { greet: { total: 1, items: [{ who: 'world' }] } } }),
        stepState('greet', 0, 'say', { status: 'failed', error: { code: 'B', message: 'x' } }),
      ),
      withSteps(
        makeState({ expansions: { greet: { total: 1, items: [{ who: 'world' }] } } }),
        stepState('greet', 0, 'say', { status: 'skipped' }),
      ),
      withSteps(
        makeState({ expansions: { greet: { total: 1, items: [{ who: 'world' }] } } }),
        stepState('greet', 0, 'say', { status: 'cancelled' }),
      ),
    ]
    for (const state of cases) {
      const ctx = buildJobContexts(hello, state, 'slow')
      expect(evalValue('${{ needs.greet.result }}', ctx)).toBe(jobResult(hello, state, 'greet'))
    }
  })
})

// ---------------------------------------------------------------------------
// refsIn
// ---------------------------------------------------------------------------

describe('refsIn', () => {
  it('collects the upstream values a step reads, in encounter order', () => {
    expect(refsIn(hello.jobs.slow!.steps[0]!.raw.with)).toEqual([
      { context: 'needs', name: 'greet', output: 'lines' },
      { context: 'inputs', name: 'photo' },
    ])
  })

  it('reads a step output out of a summary string', () => {
    expect(refsIn(hello.jobs.greet!.steps[0]!.raw.summary)).toEqual([
      { context: 'steps', name: 'say', output: 'line' },
    ])
  })

  it('ignores roots that are not upstream data (matrix, step, response)', () => {
    expect(refsIn(hello.jobs.greet!.steps[0]!.raw.with)).toEqual([
      { context: 'inputs', name: 'greeting' },
      { context: 'inputs', name: 'shout' },
    ])
    expect(refsIn(hello.jobs.greet!.steps[0]!.raw.outputs)).toEqual([])
  })

  it('walks nested structures once and de-duplicates', () => {
    expect(
      refsIn({
        a: '${{ inputs.a }}',
        b: ['${{ inputs.a }} and ${{ steps.s.outputs.o }}', { c: '${{ needs.j.outputs.o }}' }],
      }),
    ).toEqual([
      { context: 'inputs', name: 'a' },
      { context: 'steps', name: 's', output: 'o' },
      { context: 'needs', name: 'j', output: 'o' },
    ])
  })

  it('skips an expression that does not parse rather than throwing', () => {
    expect(() => refsIn('${{ inputs. }}')).not.toThrow()
    expect(refsIn(['${{ inputs. }}', '${{ inputs.ok }}'])).toEqual([
      { context: 'inputs', name: 'ok' },
    ])
  })

  it('collects only `outputs` reads of steps and needs', () => {
    expect(refsIn('${{ steps.boom.error.code }} ${{ needs.greet.result }}')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// firstStepWhere (apps#370): the topological pick behind `firstWaitingStep`
// ---------------------------------------------------------------------------

describe('firstStepWhere', () => {
  /** Two layer-0 jobs feeding a tail; the tail is inserted into the state first. */
  const parallel: Definition = toDefinition({
    name: 'Parallel',
    jobs: {
      z: { steps: [step('s')] },
      a: { steps: [step('s')] },
      tail: { needs: ['z', 'a'], steps: [step('s')] },
    },
  })

  function running(job: string): StepState {
    return {
      key: stepKey(job, 0, 's'),
      job,
      index: 0,
      stepId: 's',
      kind: 'island',
      status: 'running',
      attempt: 1,
      annotations: [],
    }
  }

  const stateWith = (steps: Record<string, StepState>): RunState => ({
    runId: 'r',
    impl: 'i',
    workflow: 'w',
    status: 'running',
    headless: false,
    inputs: {},
    steps,
    expansions: {},
    annotations: [],
    startedAt: 0,
  })

  it('walks jobs in topological order, not in the order the state happens to hold them', () => {
    const state = stateWith({
      [stepKey('tail', 0, 's')]: running('tail'),
      [stepKey('z', 0, 's')]: running('z'),
      [stepKey('a', 0, 's')]: running('a'),
    })
    const pick = firstStepWhere(parallel, state, (s) => s.status === 'running')
    expect(pick).toBe(stepKey(jobOrder(parallel)[0]!, 0, 's'))
    expect(pick).not.toBe(stepKey('tail', 0, 's'))
  })

  it('returns null when nothing matches', () => {
    expect(firstStepWhere(parallel, stateWith({}), () => true)).toBeNull()
  })
})
