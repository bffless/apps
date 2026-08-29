import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from './definition'
import type { Definition, RunState, StepState } from './types'
import { stepKey } from './types'
import {
  buildContexts,
  buildJobContexts,
  buildRunContexts,
  evalDeep,
  evalIf,
  evalValue,
  jobOutcome,
  statusFns,
} from './contexts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two jobs `a` → `b`; `a` has steps `s1`, `s2`. `s1` tolerates failure. */
const smallDef: Definition = toDefinition({
  name: 'Small',
  on: { manual: { inputs: { greeting: { type: 'string' }, names: { type: 'choice', list: true } } } },
  jobs: {
    a: {
      steps: [
        {
          id: 's1',
          uses: 'pipeline',
          'continue-on-error': true,
          with: { path: 'echo' },
          outputs: { x: { type: 'string', value: '${{ response.text }}' } },
        },
        { id: 's2', uses: 'pipeline', with: { path: 'echo' } },
      ],
      outputs: { y: '${{ steps.s1.outputs.x }}' },
    },
    b: {
      needs: 'a',
      steps: [{ id: 't1', uses: 'pipeline', with: { path: 'echo' } }],
      outputs: { z: '${{ needs.a.outputs.y }}' },
    },
  },
  outputs: { all: '${{ jobs.a.outputs.y }}' },
})

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

function makeState(over: Partial<RunState> = {}): RunState {
  return {
    runId: 'run_TEST',
    impl: 'hello',
    workflow: 'hello',
    status: 'running',
    headless: false,
    unattended: false,
    inputs: { greeting: 'Hello', names: ['world', 'studio'], shout: false },
    steps: {},
    expansions: {},
    annotations: [],
    startedAt: 1_000,
    ...over,
  }
}

function step(
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

describe('buildContexts — inputs', () => {
  // (1)
  it('exposes the kickoff inputs', () => {
    const ctx = buildContexts(hello, makeState(), { job: 'greet', index: 0, stepId: 'say' })
    expect(ctx.inputs).toEqual({ greeting: 'Hello', names: ['world', 'studio'], shout: false })
    expect(evalValue('${{ inputs.greeting }}', ctx)).toBe('Hello')
  })
})

describe('buildContexts — steps visibility', () => {
  // (2)
  const state = withSteps(
    makeState(),
    step('a', 0, 's1', { outputs: { x: 'from s1' } }),
  )

  it('shows an earlier step to a later one', () => {
    const ctx = buildContexts(smallDef, state, { job: 'a', index: 0, stepId: 's2' })
    expect(evalValue('${{ steps.s1.outputs.x }}', ctx)).toBe('from s1')
    expect(evalValue('${{ steps.s1.outcome }}', ctx)).toBe('success')
  })

  it('hides a step from itself', () => {
    const ctx = buildContexts(smallDef, state, { job: 'a', index: 0, stepId: 's1' })
    expect(evalValue('${{ steps.s1.outputs.x }}', ctx)).toBeNull()
  })

  it('shows a step to itself when selfOutputs is supplied (summary/annotations)', () => {
    const ctx = buildContexts(smallDef, state, {
      job: 'a',
      index: 0,
      stepId: 's1',
      selfOutputs: { x: 'own value' },
    })
    expect(evalValue('${{ steps.s1.outputs.x }}', ctx)).toBe('own value')
  })

  it('does not leak steps of another matrix item', () => {
    const ctx = buildContexts(smallDef, state, { job: 'a', index: 1, stepId: 's2' })
    expect(evalValue('${{ steps.s1.outputs.x }}', ctx)).toBeNull()
  })
})

describe('buildJobContexts — needs', () => {
  // (3)
  const state = withSteps(
    makeState({
      expansions: { greet: { total: 2, items: [{ who: 'world' }, { who: 'studio' }] } },
    }),
    step('greet', 0, 'say', { outputs: { line: 'Hello, world!' } }),
    step('greet', 1, 'say', { outputs: { line: 'Hello, studio!' } }),
  )

  it('collects a matrix job’s outputs into a list, in matrix order', () => {
    const ctx = buildJobContexts(hello, state, 'slow')
    expect(evalValue('${{ needs.greet.outputs.lines }}', ctx)).toEqual([
      'Hello, world!',
      'Hello, studio!',
    ])
    expect(evalValue('${{ needs.greet.result }}', ctx)).toBe('success')
  })

  it('yields null outputs for a job that never ran', () => {
    const ctx = buildJobContexts(hello, makeState(), 'slow')
    expect(evalValue('${{ needs.greet.outputs.lines }}', ctx)).toBeNull()
  })

  it('does not expose jobs that are not needed', () => {
    const ctx = buildJobContexts(hello, state, 'slow')
    expect(evalValue('${{ needs.flaky }}', ctx)).toBeNull()
  })

  it('exposes jobs.<id> in top-level output contexts only', () => {
    const runCtx = buildRunContexts(hello, state)
    expect(evalValue('${{ jobs.greet.outputs.lines }}', runCtx)).toEqual([
      'Hello, world!',
      'Hello, studio!',
    ])
    const jobCtx = buildJobContexts(hello, state, 'slow')
    expect(jobCtx.jobs).toBeUndefined()
  })
})

describe('evalIf', () => {
  // (4)
  it('defaults to success() when the expression is absent', () => {
    const state = makeState()
    const ctx = buildContexts(smallDef, state, { job: 'a', index: 0, stepId: 's1' })
    const status = statusFns(smallDef, state, { job: 'a', index: 0, beforeStep: 's1' })
    expect(evalIf(undefined, ctx, status)).toBe(status.success())
    expect(evalIf(undefined, ctx, status)).toBe(true)
  })

  it('defaults to success() — which is false once a need failed', () => {
    // `slow` needs `greet`; greet's only step failed untolerated.
    const state = withSteps(
      makeState(),
      step('greet', 0, 'say', { status: 'failed', error: { code: 'BOOM', message: 'x' } }),
    )
    const ctx = buildJobContexts(hello, state, 'slow')
    const status = statusFns(hello, state, { job: 'slow' })
    expect(status.success()).toBe(false)
    expect(evalIf(undefined, ctx, status)).toBe(false)
    expect(evalIf('failure()', ctx, status)).toBe(true)
  })

  it('parses a bare (un-templated) string as one whole expression', () => {
    const state = makeState()
    const ctx = buildContexts(smallDef, state, { job: 'a', index: 0, stepId: 's2' })
    const status = statusFns(smallDef, state, { job: 'a', index: 0, beforeStep: 's2' })
    expect(evalIf("inputs.greeting == 'Hello'", ctx, status)).toBe(true)
    // A comparison that is false must stay false: an implementation that routed
    // a bare string through renderTemplate would hand back the literal source
    // (a truthy non-empty string) and pass the assertion above.
    expect(evalIf("inputs.greeting == 'Nope'", ctx, status)).toBe(false)
    expect(evalIf('${{ inputs.shout }}', ctx, status)).toBe(false)
    expect(evalIf('always()', ctx, status)).toBe(true)
  })

  it('reports cancelled() from the run status', () => {
    const state = makeState({ status: 'cancelled' })
    const ctx = buildContexts(smallDef, state, { job: 'a', index: 0, stepId: 's2' })
    const status = statusFns(smallDef, state, { job: 'a', index: 0, beforeStep: 's2' })
    expect(evalIf('cancelled()', ctx, status)).toBe(true)
  })
})

describe('continue-on-error', () => {
  // (5)
  const state = withSteps(
    makeState(),
    step('a', 0, 's1', { status: 'failed', error: { code: 'TEAPOT', message: 'nope' } }),
  )

  it('keeps outcome failure but concludes success, and later success() still holds', () => {
    const ctx = buildContexts(smallDef, state, { job: 'a', index: 0, stepId: 's2' })
    expect(evalValue('${{ steps.s1.outcome }}', ctx)).toBe('failure')
    expect(evalValue('${{ steps.s1.conclusion }}', ctx)).toBe('success')
    expect(evalValue('${{ steps.s1.error.code }}', ctx)).toBe('TEAPOT')

    const status = statusFns(smallDef, state, { job: 'a', index: 0, beforeStep: 's2' })
    expect(status.success()).toBe(true)
    expect(status.failure()).toBe(false)
  })

  it('an untolerated failure flips success()/failure() for later steps', () => {
    const failed = withSteps(
      makeState(),
      step('greet', 0, 'say', { status: 'failed', error: { code: 'BOOM', message: 'x' } }),
    )
    const status = statusFns(hello, failed, { job: 'greet', index: 0, beforeStep: 'say' })
    // `say` is the first step: nothing earlier failed.
    expect(status.success()).toBe(true)

    const downstream = statusFns(hello, failed, { job: 'slow' })
    expect(downstream.success()).toBe(false)
    expect(downstream.failure()).toBe(true)
  })

  it('exposes the last failed step of the item on the `error` root', () => {
    const ctx = buildContexts(smallDef, state, { job: 'a', index: 0, stepId: 's2' })
    expect(evalValue('${{ error.code }}', ctx)).toBe('TEAPOT')
  })
})

describe('fail-fast — failure outranks cancelled', () => {
  // `fail-fast: true` is the default (01): a failing matrix job ends with one
  // failed step AND cancelled siblings. The job result must still be `failure`,
  // or a downstream `if: failure()` cleanup job would never run.
  const state = withSteps(
    makeState({
      expansions: { greet: { total: 2, items: [{ who: 'world' }, { who: 'studio' }] } },
    }),
    step('greet', 0, 'say', { status: 'failed', error: { code: 'BOOM', message: 'x' } }),
    step('greet', 1, 'say', { status: 'cancelled' }),
  )

  it('reports the job as failed, not cancelled', () => {
    const ctx = buildJobContexts(hello, state, 'slow')
    expect(evalValue('${{ needs.greet.result }}', ctx)).toBe('failure')
    expect(evalValue("${{ needs.greet.result == 'failure' }}", ctx)).toBe(true)
    expect(evalValue('${{ needs.greet.outputs.lines }}', ctx)).toBeNull()
  })

  it('lets a downstream `if: failure()` job run', () => {
    const ctx = buildJobContexts(hello, state, 'slow')
    const status = statusFns(hello, state, { job: 'slow' })
    expect(status.failure()).toBe(true)
    expect(status.success()).toBe(false)
    expect(evalIf('failure()', ctx, status)).toBe(true)
    expect(evalIf(undefined, ctx, status)).toBe(false)
  })
})

describe('evalDeep', () => {
  // (6)
  it('interpolates strings and keeps the type of a single expression', () => {
    const state = makeState({
      expansions: { greet: { total: 2, items: [{ who: 'world' }, { who: 'studio' }] } },
    })
    const ctx = buildContexts(hello, state, { job: 'greet', index: 0, stepId: 'say' })
    expect(
      evalDeep({ body: { text: '${{ inputs.greeting }}, ${{ matrix.who }}!' } }, ctx),
    ).toEqual({ body: { text: 'Hello, world!' } })
    expect(evalDeep('${{ inputs.names }}', ctx)).toEqual(['world', 'studio'])
    expect(evalDeep(['${{ inputs.shout }}', 7, null], ctx)).toEqual([false, 7, null])
  })
})

describe('matrix and strategy', () => {
  // (7)
  it('binds matrix.<var>, strategy.job-index and strategy.job-total', () => {
    const state = makeState({
      expansions: { greet: { total: 2, items: [{ who: 'world' }, { who: 'studio' }] } },
    })
    const ctx = buildContexts(hello, state, { job: 'greet', index: 1, stepId: 'say' })
    expect(ctx.matrix).toEqual({ who: 'studio' })
    expect(evalValue('${{ matrix.who }}', ctx)).toBe('studio')
    expect(evalValue("${{ strategy['job-index'] }}", ctx)).toBe(1)
    expect(evalValue("${{ strategy['job-total'] }}", ctx)).toBe(2)
  })
})

describe('run, step and impl', () => {
  // (8)
  it('builds the run/step storage prefixes and the impl paths', () => {
    const state = makeState()
    const ctx = buildContexts(hello, state, { job: 'greet', index: 0, stepId: 'say', attempt: 2 })
    expect(ctx.run).toMatchObject({
      id: 'run_TEST',
      prefix: 'workflows/hello/hello/runs/run_TEST',
      headless: false,
      started_at: 1_000,
    })
    expect(ctx.step).toEqual({
      key: 'greet/0/say',
      prefix: 'workflows/hello/hello/runs/run_TEST/greet/0/say',
      attempt: 2,
    })
    expect(evalValue('${{ step.prefix }}', ctx)).toBe(
      'workflows/hello/hello/runs/run_TEST/greet/0/say',
    )
    expect(ctx.impl).toEqual({ alias: 'hello', base: '/w/hello', api: '/api/hello' })
  })

  it('omits the step context at a job-level site', () => {
    const ctx = buildJobContexts(hello, makeState(), 'greet')
    expect(ctx.step).toBeUndefined()
    expect(ctx.run).toBeDefined()
    expect(ctx.impl).toBeDefined()
  })
})

describe('response overlay', () => {
  it('exposes the scope response to a pipeline step slot', () => {
    const ctx = buildContexts(hello, makeState(), {
      job: 'greet',
      index: 0,
      stepId: 'say',
      response: { text: 'Hello, world!' },
    })
    expect(evalValue('${{ response.text }}', ctx)).toBe('Hello, world!')
  })
})

// ---------------------------------------------------------------------------
// A skipped step that CARRIES outputs is a producing step (R66, Task 12)
// ---------------------------------------------------------------------------

/**
 * hello's `review` job in miniature (`interactive.workflow.yaml`): one `form`
 * step whose `headless: skip` stands a File ref in for the cover a person would
 * have picked, a job output that passes the ref through whole, and a dependent
 * job that reads it. The state is built by hand — how the skip arrived at its
 * outputs is `evaluateSkipOutputs`' business (and the middleware suite's); what
 * is pinned here is that a job holding one is `success`, so its outputs are
 * readable rather than nulled.
 */
const POSTER = {
  path: 'runs/run_TEST/poster.svg',
  name: 'poster.svg',
  contentType: 'image/svg+xml',
  size: 42,
  url: '/api/uploads/runs/run_TEST/poster.svg',
}

const skipDef: Definition = toDefinition({
  name: 'Headless skip',
  jobs: {
    review: {
      steps: [
        {
          id: 'confirm',
          uses: 'form',
          with: {
            title: 'Review the card',
            fields: { cover: { type: 'choice', options: '${{ inputs.posters }}', required: true } },
            submit: 'Approve',
          },
          headless: { mode: 'skip', outputs: { cover: '${{ inputs.posters[0] }}' } },
        },
      ],
      outputs: { cover: { type: 'file', value: '${{ steps.confirm.outputs.cover }}' } },
    },
    ship: {
      needs: 'review',
      steps: [{ id: 'send', uses: 'pipeline', with: { path: 'echo' } }],
      outputs: { name: '${{ needs.review.outputs.cover.name }}' },
    },
  },
  outputs: { cover: '${{ jobs.review.outputs.cover }}' },
})

/**
 * The **bare** `headless: skip` form (07's own table): no `outputs:` map at
 * all, which `evaluateSkipOutputs` turns into `{}`. It still stands in for the
 * work, so R66 must count it — a job that read `skipped` here and `success`
 * attended would gate every downstream `needs` differently.
 */
const bareSkipDef: Definition = toDefinition({
  name: 'Bare headless skip',
  jobs: {
    review: {
      steps: [
        {
          id: 'confirm',
          uses: 'form',
          with: { title: 'Have a look', fields: {}, submit: 'Approve' },
          headless: 'skip',
        },
      ],
    },
    ship: {
      needs: 'review',
      steps: [{ id: 'send', uses: 'pipeline', with: { path: 'echo' } }],
    },
  },
})

/** The same shape, but the job's one step was skipped by `if:` and carries nothing. */
const ifSkipDef: Definition = toDefinition({
  name: 'if-skipped',
  jobs: {
    review: {
      steps: [{ id: 'confirm', uses: 'pipeline', if: '${{ false }}', with: { path: 'echo' } }],
      outputs: { cover: '${{ steps.confirm.outputs.cover }}' },
    },
  },
  outputs: { cover: '${{ jobs.review.outputs.cover }}' },
})

describe('jobOutcome — a skipped step that carries outputs', () => {
  const skipped = (over: Partial<StepState> = {}) =>
    step('review', 0, 'confirm', { kind: 'form', status: 'skipped', ...over })

  it('makes its job succeed, so the job and run outputs carry the skip values', () => {
    const state = withSteps(makeState(), skipped({ outputs: { cover: POSTER } }))

    expect(jobOutcome(skipDef, state, 'review')).toBe('success')
    expect(evalValue('${{ jobs.review.outputs.cover }}', buildRunContexts(skipDef, state))).toEqual(
      POSTER,
    )
    // …and a dependent job reads it exactly as it would in an interactive run.
    const shipCtx = buildJobContexts(skipDef, state, 'ship')
    expect(evalValue('${{ needs.review.result }}', shipCtx)).toBe('success')
    expect(evalValue('${{ needs.review.outputs.cover.name }}', shipCtx)).toBe('poster.svg')
  })

  it('counts a bare `headless: skip` too — its outputs are {}, which is not nothing', () => {
    const state = withSteps(makeState(), skipped({ outputs: {} }))

    expect(jobOutcome(bareSkipDef, state, 'review')).toBe('success')
    expect(
      evalValue('${{ needs.review.result }}', buildJobContexts(bareSkipDef, state, 'ship')),
    ).toBe('success')
  })

  it('leaves an if-skipped job skipped, with null outputs (the pre-existing rule)', () => {
    const state = withSteps(makeState(), skipped({ kind: 'pipeline' }))

    expect(jobOutcome(ifSkipDef, state, 'review')).toBe('skipped')
    expect(
      evalValue('${{ jobs.review.outputs.cover }}', buildRunContexts(ifSkipDef, state)),
    ).toBeNull()
  })

  it('leaves a mixed job succeeding, as it already did', () => {
    const state = withSteps(
      makeState(),
      step('a', 0, 's1', { status: 'skipped', outputs: { x: 'stood in' } }),
      step('a', 0, 's2'),
    )

    expect(jobOutcome(smallDef, state, 'a')).toBe('success')
    expect(evalValue('${{ jobs.a.outputs.y }}', buildRunContexts(smallDef, state))).toBe('stood in')
  })

  it('counts a skipped-with-outputs step as a producing matrix item', () => {
    // `itemProduced` already agrees — a skip is neither cancelled nor a failure
    // — and this pins that agreement rather than changing it.
    const state = withSteps(
      makeState({ expansions: { greet: { total: 2, items: [{ who: 'a' }, { who: 'b' }] } } }),
      step('greet', 0, 'say', { status: 'skipped', outputs: { line: 'stood in' } }),
      step('greet', 1, 'say', { outputs: { line: 'Hello, b!' } }),
    )

    expect(jobOutcome(hello, state, 'greet')).toBe('success')
    expect(evalValue('${{ jobs.greet.outputs.lines }}', buildRunContexts(hello, state))).toEqual([
      'stood in',
      'Hello, b!',
    ])
  })
})
