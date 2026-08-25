import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../definition'
import type { Definition, RunState, Step, StepState } from '../types'
import { stepKey } from '../types'
import { completeFormStep, formInitialValues } from './form'

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

function stepOf(def: Definition, job: string, id: string): Step {
  const step = def.jobs[job]?.steps.find((s) => s.id === id)
  if (!step) throw new Error(`no such step ${job}.${id}`)
  return step
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
    status: 'queued',
    attempt: 1,
    annotations: [],
    ...over,
  }
}

const REVIEW_KEY = stepKey('confirm', 0, 'review')

/** `slow` has produced its report; `confirm.review` is waiting on the user. */
function confirmState(): RunState {
  return {
    runId: 'run_TEST',
    impl: 'hello',
    workflow: 'hello',
    status: 'running',
    headless: false,
    inputs: { greeting: 'Hello', names: ['world'], photo: null, shout: false },
    steps: {
      [stepKey('slow', 0, 'start')]: stepState('slow', 0, 'start', {
        status: 'succeeded',
        outputs: { report: '# r', poster: null },
      }),
      [REVIEW_KEY]: stepState('confirm', 0, 'review', { kind: 'form', status: 'waiting' }),
    },
    expansions: { greet: { total: 1, items: [{ who: 'world' }] } },
    annotations: [],
    startedAt: 1_000,
  }
}

function args(values: Record<string, unknown>) {
  const state = confirmState()
  return {
    step: stepOf(hello, 'confirm', 'review'),
    key: REVIEW_KEY,
    job: 'confirm',
    index: 0,
    def: hello,
    state,
    values,
    at: 1_000,
  }
}

describe('completeFormStep (hello confirm.review)', () => {
  it('accepts a valid submit and produces the field values as outputs', () => {
    const result = completeFormStep(args({ approved: true, report: '# r' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.type).toBe('step.succeeded')
    expect(result.event.key).toBe(REVIEW_KEY)
    expect(result.event.outputs).toEqual({ approved: true, report: '# r' })
    expect(result.event.annotations).toEqual([])
    expect(typeof result.event.at).toBe('number')
  })

  it('rejects a value that does not match its declared type', () => {
    const result = completeFormStep(args({ approved: 'yes', report: '# r' }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors)).toEqual(['approved'])
    expect(result.errors.approved).toMatch(/boolean/)
  })

  it('rejects a missing required field', () => {
    const result = completeFormStep(args({ report: '# r' }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors)).toEqual(['approved'])
    expect(result.errors.approved).toMatch(/required/i)
  })

  it('accepts an omitted optional field as null and ignores undeclared keys', () => {
    const result = completeFormStep(args({ approved: false, sneaky: 'nope' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.outputs).toEqual({ approved: false, report: null })
  })

  it('evaluates the step summary against its own outputs', () => {
    const withSummary = toDefinition({
      name: 'Summarised',
      jobs: {
        j: {
          steps: [
            {
              id: 'f',
              uses: 'form',
              with: { fields: { note: { type: 'string' } } },
              summary: 'Noted **${{ steps.f.outputs.note }}**',
              annotations: [{ level: 'notice', message: 'note: ${{ steps.f.outputs.note }}' }],
            },
          ],
          outputs: {},
        },
      },
      outputs: {},
    }) as Definition
    const key = stepKey('j', 0, 'f')
    const state: RunState = {
      ...confirmState(),
      steps: { [key]: stepState('j', 0, 'f', { kind: 'form', status: 'waiting' }) },
    }

    const result = completeFormStep({
      step: stepOf(withSummary, 'j', 'f'),
      key,
      job: 'j',
      index: 0,
      def: withSummary,
      state,
      values: { note: 'hi' },
      at: 1_000,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.summary).toBe('Noted **hi**')
    expect(result.event.annotations).toEqual([{ level: 'notice', message: 'note: hi' }])
  })

  it('validates a list field against its element type', () => {
    const listy = toDefinition({
      name: 'Listy',
      jobs: {
        j: {
          steps: [
            {
              id: 'f',
              uses: 'form',
              with: { fields: { tags: { type: 'choice', list: true, required: true } } },
            },
          ],
          outputs: {},
        },
      },
      outputs: {},
    }) as Definition
    const key = stepKey('j', 0, 'f')
    const state: RunState = {
      ...confirmState(),
      steps: { [key]: stepState('j', 0, 'f', { kind: 'form', status: 'waiting' }) },
    }
    const base = { step: stepOf(listy, 'j', 'f'), key, job: 'j', index: 0, def: listy, state, at: 1 }

    expect(completeFormStep({ ...base, values: { tags: ['a', 'b'] } }).ok).toBe(true)
    expect(completeFormStep({ ...base, values: { tags: 'a' } }).ok).toBe(false)
    expect(completeFormStep({ ...base, values: { tags: [] } }).ok).toBe(false) // required
  })
})

describe('formInitialValues (hello confirm.review)', () => {
  it('resolves expression defaults against the run so far', () => {
    const values = formInitialValues({
      step: stepOf(hello, 'confirm', 'review'),
      def: hello,
      state: confirmState(),
      job: 'confirm',
      index: 0,
    })

    // `default: ${{ needs.slow.outputs.report }}` — slow's job output, from its step.
    expect(values).toEqual({ approved: true, report: '# r' })
  })

  it('gives a field with no default a null initial value', () => {
    const bare = toDefinition({
      name: 'Bare',
      jobs: {
        j: {
          steps: [
            { id: 'f', uses: 'form', with: { fields: { note: { type: 'string' } } } },
          ],
          outputs: {},
        },
      },
      outputs: {},
    }) as Definition

    expect(
      formInitialValues({
        step: stepOf(bare, 'j', 'f'),
        def: bare,
        state: { ...confirmState(), steps: {} },
        job: 'j',
        index: 0,
      }),
    ).toEqual({ note: null })
  })
})

// ---------------------------------------------------------------------------
// apps#370 — host polish follow-ups
// ---------------------------------------------------------------------------

describe('completeFormStep — clock injection (#370)', () => {
  it('stamps the caller-supplied `at` rather than reading the wall clock', () => {
    const result = completeFormStep({ ...args({ approved: true, report: '# r' }), at: 42 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.at).toBe(42)
  })

  it('reads a submitted field named after an Object.prototype member by own key only', () => {
    const proto: Definition = toDefinition({
      name: 'Proto',
      jobs: {
        confirm: {
          steps: [
            {
              id: 'review',
              uses: 'form',
              with: { fields: { constructor: { type: 'string' }, toString: {} } },
            },
          ],
        },
      },
    }) as Definition
    const base = { ...args({}), def: proto, step: stepOf(proto, 'confirm', 'review'), at: 1 }

    const omitted = completeFormStep({ ...base, values: {} })
    expect(omitted).toMatchObject({
      ok: true,
      event: { outputs: { constructor: null, toString: null } },
    })

    const given = completeFormStep({ ...base, values: { constructor: 'c', toString: 't' } })
    expect(given).toMatchObject({
      ok: true,
      event: { outputs: { constructor: 'c', toString: 't' } },
    })
  })
})
