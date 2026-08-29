import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from './definition'
import type { Definition, RunState, Step } from './types'
import { buildContexts } from './contexts'
import { evalAnnotations, evalSummary, isTruncatedStub, trimResponse } from './results'

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

function makeState(over: Partial<RunState> = {}): RunState {
  return {
    runId: 'run_TEST',
    impl: 'hello',
    workflow: 'hello',
    status: 'running',
    headless: false,
    unattended: false,
    inputs: { greeting: 'Hello', names: ['world'], shout: false },
    steps: {},
    expansions: {},
    annotations: [],
    startedAt: 1_000,
    ...over,
  }
}

describe('evalSummary', () => {
  it('renders the say step summary from its own outputs', () => {
    const say = hello.jobs.greet!.steps.find((s) => s.id === 'say')! as Step
    const ctx = buildContexts(hello, makeState(), {
      job: 'greet',
      index: 0,
      stepId: 'say',
      selfOutputs: { line: 'Hello, world!' },
    })
    expect(evalSummary(say, ctx)).toBe('Said **Hello, world!**')
  })

  it('returns undefined when the step declares no summary', () => {
    const start = hello.jobs.slow!.steps.find((s) => s.id === 'start')! as Step
    const ctx = buildContexts(hello, makeState(), { job: 'slow', index: 0, stepId: 'start' })
    expect(evalSummary(start, ctx)).toBeUndefined()
  })
})

describe('evalAnnotations', () => {
  const gated: Definition = toDefinition({
    name: 'Gated',
    jobs: {
      a: {
        steps: [
          {
            id: 'x',
            uses: 'pipeline',
            with: { path: 'echo' },
            annotations: [
              { level: 'notice', message: 'Always shown' },
              { level: 'warning', if: '${{ response.ok }}', message: 'Only when ok' },
            ],
          },
        ],
        outputs: {},
      },
    },
    outputs: {},
  })

  it('drops an entry whose `if` evaluates false and keeps the rest', () => {
    const step = gated.jobs.a!.steps[0]! as Step
    const ctx = buildContexts(gated, makeState(), { job: 'a', index: 0, stepId: 'x', response: { ok: false } })
    const result = evalAnnotations(step, ctx)
    expect(result).toEqual([{ level: 'notice', message: 'Always shown' }])
  })

  it('includes an entry whose `if` evaluates true', () => {
    const step = gated.jobs.a!.steps[0]! as Step
    const ctx = buildContexts(gated, makeState(), { job: 'a', index: 0, stepId: 'x', response: { ok: true } })
    const result = evalAnnotations(step, ctx)
    expect(result).toEqual([
      { level: 'notice', message: 'Always shown' },
      { level: 'warning', message: 'Only when ok' },
    ])
  })

  it('returns [] for a step with no annotations declared', () => {
    const say = hello.jobs.greet!.steps.find((s) => s.id === 'say')! as Step
    const ctx = buildContexts(hello, makeState(), { job: 'greet', index: 0, stepId: 'say' })
    expect(evalAnnotations(say, ctx)).toEqual([])
  })

  it('evaluates the message template against self outputs (after step, hello fixture)', () => {
    const after = hello.jobs.flaky!.steps.find((s) => s.id === 'after')! as Step
    const ctx = buildContexts(hello, makeState(), {
      job: 'flaky',
      index: 0,
      stepId: 'after',
      selfOutputs: { note: 'boom failed with TEAPOT' },
    })
    expect(evalAnnotations(after, ctx)).toEqual([
      { level: 'warning', message: 'boom failed with TEAPOT' },
    ])
  })
})

describe('trimResponse', () => {
  it('leaves a small response untouched', () => {
    const result = trimResponse({ initial: { a: 1 }, last: { b: 2 } })
    expect(result).toEqual({ initial: { a: 1 }, last: { b: 2 } })
    expect(result.truncated).toBeUndefined()
  })

  it('trims `last` first when it alone pushes the response over 256 KB', () => {
    const big = 'x'.repeat(300 * 1024)
    const result = trimResponse({ initial: { small: true }, last: { big } })
    expect(result.truncated).toBe(true)
    expect(result.initial).toEqual({ small: true })
    expect(result.last).toMatchObject({ note: 'truncated' })
    expect(typeof (result.last as { size: number }).size).toBe('number')
    const serializedSize = new TextEncoder().encode(JSON.stringify(result)).length
    expect(serializedSize).toBeLessThan(262_144)
  })

  it('trims `initial` too when trimming `last` alone is not enough', () => {
    const big = 'x'.repeat(300 * 1024)
    const result = trimResponse({ initial: { big }, last: { big } })
    expect(result.truncated).toBe(true)
    expect(result.initial).toMatchObject({ note: 'truncated' })
    expect(result.last).toMatchObject({ note: 'truncated' })
    const serializedSize = new TextEncoder().encode(JSON.stringify(result)).length
    expect(serializedSize).toBeLessThan(262_144)
  })
})

describe('isTruncatedStub', () => {
  it('recognises exactly the marker `trimResponse` stubs a half with', () => {
    const trimmed = trimResponse({ initial: { blob: 'x'.repeat(300 * 1024) } })
    expect(isTruncatedStub(trimmed.initial)).toBe(true)
  })

  it('is the literal { note: "truncated", size: <number> } shape and nothing wider', () => {
    expect(isTruncatedStub({ note: 'truncated', size: 999_999 })).toBe(true)
    expect(isTruncatedStub({ note: 'truncated', size: '999999' })).toBe(false)
    expect(isTruncatedStub({ note: 'truncated' })).toBe(false)
    expect(isTruncatedStub({ note: 'truncated', size: 1, extra: 2 })).toBe(false)
    expect(isTruncatedStub({ jobId: 'job_1' })).toBe(false)
    expect(isTruncatedStub(null)).toBe(false)
    expect(isTruncatedStub([{ note: 'truncated', size: 1 }])).toBe(false)
  })
})
