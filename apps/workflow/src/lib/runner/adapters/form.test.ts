import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../definition'
import type { Definition, FileRef, RunState, Step, StepState } from '../types'
import { stepKey } from '../types'
import { completeFormStep, formFieldDefs, formInitialValues, optionValues } from './form'

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

// ---------------------------------------------------------------------------
// Task 18 — `options` expressions, File-ref options, `file` fields
// ---------------------------------------------------------------------------

const COVER_A: FileRef = {
  path: 'workflows/hello/hello/runs/run_TEST/pick/0/draw/a.png',
  name: 'a.png',
  contentType: 'image/png',
  size: 11,
  url: '/api/uploads/hello/hello/runs/run_TEST/pick/0/draw/a.png',
}
const COVER_B: FileRef = {
  ...COVER_A,
  path: 'workflows/hello/hello/runs/run_TEST/pick/0/draw/b.png',
  name: 'b.png',
  url: '/api/uploads/hello/hello/runs/run_TEST/pick/0/draw/b.png',
}

/** `draw` produced a File list; `choose` is a form whose options are that list. */
const COVERS: Definition = toDefinition({
  name: 'Covers',
  jobs: {
    pick: {
      steps: [
        { id: 'draw', uses: 'script', with: { run: 'draw.js' }, outputs: { options: { type: 'file', list: true } } },
        {
          id: 'choose',
          uses: 'form',
          with: {
            fields: {
              cover: { type: 'choice', options: '${{ steps.draw.outputs.options }}', required: true },
              attachment: { type: 'file' },
            },
          },
        },
      ],
    },
  },
}) as Definition

const CHOOSE_KEY = stepKey('pick', 0, 'choose')

function coversState(drawOptions: unknown = [COVER_A, COVER_B]): RunState {
  return {
    ...confirmState(),
    steps: {
      [stepKey('pick', 0, 'draw')]: stepState('pick', 0, 'draw', {
        kind: 'script',
        status: 'succeeded',
        outputs: { options: drawOptions },
      }),
      [CHOOSE_KEY]: stepState('pick', 0, 'choose', { kind: 'form', status: 'waiting' }),
    },
    expansions: {},
  }
}

function coverArgs(values: Record<string, unknown>, drawOptions: unknown = [COVER_A, COVER_B]) {
  return {
    step: stepOf(COVERS, 'pick', 'choose'),
    key: CHOOSE_KEY,
    job: 'pick',
    index: 0,
    def: COVERS,
    state: coversState(drawOptions),
    values,
    at: 1_000,
  }
}

describe('formFieldDefs (03: `options` may be an expression)', () => {
  it('evaluates an options expression to the upstream File-ref list', () => {
    const fields = formFieldDefs({
      step: stepOf(COVERS, 'pick', 'choose'),
      def: COVERS,
      state: coversState(),
      job: 'pick',
      index: 0,
    })

    expect(fields.cover?.options).toEqual([COVER_A, COVER_B])
    // Everything else about the field is untouched.
    expect(fields.cover?.type).toBe('choice')
    expect(fields.cover?.required).toBe(true)
    expect(fields.attachment?.type).toBe('file')
  })

  it('leaves a literal options list alone', () => {
    const literal = toDefinition({
      name: 'Literal',
      jobs: {
        j: {
          steps: [
            { id: 'f', uses: 'form', with: { fields: { size: { type: 'choice', options: ['s', 'm'] } } } },
          ],
        },
      },
    }) as Definition

    const fields = formFieldDefs({
      step: stepOf(literal, 'j', 'f'),
      def: literal,
      state: { ...confirmState(), steps: {} },
      job: 'j',
      index: 0,
    })
    expect(fields.size?.options).toEqual(['s', 'm'])
  })

  it('gives a field no choices at all when the expression is not a list', () => {
    const fields = formFieldDefs({
      step: stepOf(COVERS, 'pick', 'choose'),
      def: COVERS,
      state: coversState('not-a-list'),
      job: 'pick',
      index: 0,
    })
    expect(fields.cover?.options).toEqual([])
  })
})

describe('completeFormStep — evaluated options and file fields', () => {
  it('accepts a path that is one of the evaluated File-ref options', () => {
    const result = completeFormStep(coverArgs({ cover: COVER_A.path }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.outputs).toEqual({ cover: COVER_A.path, attachment: null })
  })

  it('rejects a value that is not one of the evaluated options', () => {
    const result = completeFormStep(coverArgs({ cover: 'nope' }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.cover).toMatch(/not one of/)
  })

  it('rejects every value when the options expression did not evaluate to a list, naming the unresolved options', () => {
    const result = completeFormStep(coverArgs({ cover: COVER_A.path }, null))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.cover).toMatch(/could not be resolved/)
  })

  it('accepts a File ref for a `file` field, and null for an unanswered one', () => {
    const withFile = completeFormStep(coverArgs({ cover: COVER_B.path, attachment: COVER_A }))
    expect(withFile.ok).toBe(true)
    if (!withFile.ok) return
    expect(withFile.event.outputs.attachment).toEqual(COVER_A)

    const without = completeFormStep(coverArgs({ cover: COVER_B.path, attachment: null }))
    expect(without.ok).toBe(true)

    const wrong = completeFormStep(coverArgs({ cover: COVER_B.path, attachment: 'just-a-path' }))
    expect(wrong.ok).toBe(false)
    if (wrong.ok) return
    expect(wrong.errors.attachment).toMatch(/file/)
  })
})

describe('optionValues (02: the one notion of "the allowed values")', () => {
  it('reads bare strings, {value} objects and the File-ref shorthand', () => {
    expect(optionValues(['a', { value: 'b', label: 'B' }, COVER_A])).toEqual(['a', 'b', COVER_A.path])
  })

  it('answers an empty list for anything that is not an array of readable options', () => {
    expect(optionValues('${{ inputs.opts }}')).toEqual([])
    expect(optionValues(undefined)).toEqual([])
    expect(optionValues([{ label: 'no value' }, 7])).toEqual([])
  })
})
