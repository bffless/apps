import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import type { Definition, RunState, Step, StepState } from '../types'
import { stepKey } from '../types'
import {
  ANNOTATION_BUDGET,
  annotateEvent,
  completeIslandStep,
  islandInputs,
  ISLAND_RESERVED,
  resolveSrc,
  resolveToolName,
} from './island'

// ---------------------------------------------------------------------------
// Fixture — one job, one island step with reserved + expression `with` keys.
// ---------------------------------------------------------------------------

const def: Definition = toDefinition({
  name: 'Islands',
  on: { manual: { inputs: { greeting: { type: 'string' } } } },
  jobs: {
    edit: {
      steps: [
        {
          id: 'trim',
          uses: 'island',
          with: {
            src: 'islands/a.html',
            title: 'T',
            display: 'fullscreen',
            clip: '${{ inputs.greeting }}',
          },
          outputs: {
            pick: { type: 'string', required: true },
            n: { type: 'number' },
          },
          summary: 'picked ${{ steps.trim.outputs.pick }}',
          annotations: [{ level: 'notice', message: 'chose ${{ steps.trim.outputs.pick }}' }],
        },
        // Same step minus the two optional reserved keys — defaults come from here.
        {
          id: 'bare',
          uses: 'island',
          with: { src: 'islands/b.html' },
        },
      ],
    },
  },
})

const TRIM = stepKey('edit', 0, 'trim')

function stepOf(id: string): Step {
  const step = def.jobs.edit?.steps.find((s) => s.id === id)
  if (!step) throw new Error(`no such step ${id}`)
  return step
}

function stepState(stepId: string, over: Partial<StepState> = {}): StepState {
  return {
    key: stepKey('edit', 0, stepId),
    job: 'edit',
    index: 0,
    stepId,
    kind: 'island',
    status: 'waiting',
    attempt: 1,
    annotations: [],
    ...over,
  }
}

function state(): RunState {
  return {
    runId: 'run_TEST',
    impl: 'studio',
    workflow: 'islands',
    status: 'running',
    headless: false,
    inputs: { greeting: 'hi' },
    steps: { [TRIM]: stepState('trim') },
    expansions: { edit: { total: 1, items: [{}] } },
    annotations: [],
    startedAt: 1_000,
  }
}

function args(stepId: string) {
  return {
    step: stepOf(stepId),
    key: stepKey('edit', 0, stepId),
    job: 'edit',
    index: 0,
    def,
    state: state(),
    at: 1_000,
  }
}

// ---------------------------------------------------------------------------
// islandInputs
// ---------------------------------------------------------------------------

describe('islandInputs', () => {
  it('evaluates `with` and splits the reserved keys off the tool arguments', () => {
    const inputs = islandInputs(args('trim'))

    expect(inputs.src).toBe('islands/a.html')
    expect(inputs.title).toBe('T')
    expect(inputs.display).toBe('fullscreen')
    expect(inputs.arguments).toEqual({ clip: 'hi' })
  })

  it('defaults display to inline and title to the step id', () => {
    const inputs = islandInputs(args('bare'))

    expect(inputs.display).toBe('inline')
    expect(inputs.title).toBe('bare')
    expect(inputs.arguments).toEqual({})
  })

  it('names the reserved keys once, for the linter and the host to share', () => {
    expect([...ISLAND_RESERVED]).toEqual(['src', 'title', 'display'])
  })

  it('throws when `src` is missing (a definition bug the linter should have caught)', () => {
    const a = args('trim')
    const step: Step = { ...a.step, raw: { ...a.step.raw, with: { title: 'T' } } }
    expect(() => islandInputs({ ...a, step })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// resolveSrc (01 Paths)
// ---------------------------------------------------------------------------

describe('resolveSrc', () => {
  it('resolves a relative src under the implementation bundle', () => {
    expect(resolveSrc('studio', 'islands/x.html')).toBe('/w/studio/islands/x.html')
  })

  it('passes an absolute /w/ path through verbatim', () => {
    expect(resolveSrc('studio', '/w/studio/islands/x.html')).toBe('/w/studio/islands/x.html')
  })

  it.each([
    '',
    '/api/studio/x.html',
    '//evil.example/x.html',
    'http://evil.example/x.html',
    'data:text/html,<b>hi',
    // Traversal, in every spelling the browser normalises before fetching:
    // a raw `..`, its percent-escape, and a backslash (WHATWG treats `\` as
    // `/` for http(s) URLs).
    '../other/x.html',
    'a/%2e%2e/%2e%2e/x.html',
    'a\\..\\..\\x.html',
    // Another implementation's bundle is not this island's to load (04).
    '/w/other/islands/x.html',
    '/w/studio/../other/x.html',
  ])('rejects %j', (src) => {
    expect(() => resolveSrc('studio', src)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// resolveToolName (Decision 1 + 10)
// ---------------------------------------------------------------------------

describe('resolveToolName', () => {
  it.each(['workflow.submit', 'workflow/submit'])('maps %s to the host submit tool', (name) => {
    expect(resolveToolName('studio', name)).toEqual({ kind: 'host', tool: 'submit' })
  })

  it.each(['workflow.annotate', 'workflow/annotate'])('maps %s to the host annotate tool', (name) => {
    expect(resolveToolName('studio', name)).toEqual({ kind: 'host', tool: 'annotate' })
  })

  it.each(['video.slice', 'video/slice'])('maps %s onto the implementation rule', (name) => {
    expect(resolveToolName('studio', name)).toEqual({
      kind: 'pipeline',
      path: 'video/slice',
      method: 'POST',
      url: '/api/studio/video/slice',
    })
  })

  it('is lossy for a path that itself contains a dot (documented, Decision 1)', () => {
    expect(resolveToolName('studio', 'feed.xml')).toMatchObject({ path: 'feed/xml' })
    expect(resolveToolName('studio', 'feed/xml')).toMatchObject({ path: 'feed/xml' })
  })

  it('honours the GET hint in _meta', () => {
    expect(
      resolveToolName('studio', 'video.status', { bffless: { method: 'GET' } }),
    ).toMatchObject({ method: 'GET' })
    expect(resolveToolName('studio', 'video.status', { bffless: {} })).toMatchObject({
      method: 'POST',
    })
    expect(resolveToolName('studio', 'video.status', 'nonsense')).toMatchObject({ method: 'POST' })
  })

  it.each([
    '',
    '/api/other/x',
    '../x',
    'a/../../b',
    'video slice',
    // Percent-escaped and backslash traversal: the browser decodes and
    // normalises before it fetches, so a raw segment scan is not enough.
    '%2e%2e/%2e%2e/x',
    'a/..\\..\\x',
    'a\\b',
    '%2fetc%2fpasswd',
  ])('rejects %j', (name) => {
    const target = resolveToolName('studio', name)
    expect(target.kind).toBe('rejected')
    if (target.kind !== 'rejected') return
    expect(typeof target.reason).toBe('string')
    expect(target.reason.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// completeIslandStep (02)
// ---------------------------------------------------------------------------

describe('completeIslandStep', () => {
  it('accepts a valid submit, drops undeclared keys and evaluates the summary', () => {
    const result = completeIslandStep({ ...args('trim'), outputs: { pick: 'a', extra: 1 } })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.type).toBe('step.succeeded')
    expect(result.event.key).toBe(TRIM)
    expect(result.event.outputs).toEqual({ pick: 'a', n: null })
    expect(result.event.summary).toBe('picked a')
    expect(result.event.annotations).toEqual([{ level: 'notice', message: 'chose a' }])
    expect(typeof result.event.at).toBe('number')
  })

  it('rejects a missing required output', () => {
    const result = completeIslandStep({ ...args('trim'), outputs: { n: 1 } })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors).toEqual({ pick: 'This field is required' })
  })

  it('rejects a type mismatch', () => {
    const result = completeIslandStep({ ...args('trim'), outputs: { pick: 1 } })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.pick).toMatch(/string/)
  })

  it.each([['not an object'], [['a']], [null], [42]])(
    'rejects a non-object outputs payload (%j)',
    (outputs) => {
      const result = completeIslandStep({ ...args('trim'), outputs })

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.errors).toEqual({ outputs: 'Expected an object of outputs' })
    },
  )

  it('accepts and ignores a JSON `schema` on a declaration (M3)', () => {
    const a = args('trim')
    const step: Step = {
      ...a.step,
      raw: {
        ...a.step.raw,
        outputs: { cuts: { type: 'json', schema: { type: 'array', items: { type: 'number' } } } },
        summary: undefined,
        annotations: undefined,
      },
    }
    // A value the schema would reject, but the *type* (json) accepts.
    const result = completeIslandStep({ ...a, step, outputs: { cuts: { not: 'an array' } } })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.outputs).toEqual({ cuts: { not: 'an array' } })
  })

  it('produces no outputs for a step that declares none', () => {
    const result = completeIslandStep({ ...args('bare'), outputs: { anything: 1 } })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.outputs).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// annotateEvent (Decision 12)
// ---------------------------------------------------------------------------

describe('annotateEvent', () => {
  it('builds a step.annotated event from annotations', () => {
    expect(
      annotateEvent(TRIM, { annotations: [{ level: 'notice', message: 'm' }] }, 5),
    ).toEqual({
      type: 'step.annotated',
      key: TRIM,
      annotations: [{ level: 'notice', message: 'm' }],
      at: 5,
    })
  })

  it('accepts a summary on its own', () => {
    expect(annotateEvent(TRIM, { summary: 'half way' }, 5)).toEqual({
      type: 'step.annotated',
      key: TRIM,
      summary: 'half way',
      at: 5,
    })
  })

  it('keeps an optional annotation title', () => {
    const event = annotateEvent(
      TRIM,
      { annotations: [{ level: 'warning', message: 'm', title: 't' }] },
      5,
    )
    expect(event).toMatchObject({ annotations: [{ level: 'warning', message: 'm', title: 't' }] })
  })

  it.each([
    ['a bad level', { annotations: [{ level: 'bogus', message: 'm' }] }],
    ['a missing message', { annotations: [{ level: 'notice' }] }],
    ['a non-array annotations', { annotations: 'm' }],
    ['a non-string summary', { summary: 5 }],
    ['neither annotations nor summary', {}],
    ['a non-object payload', 'nope'],
    ['a null payload', null],
  ])('rejects %s', (_label, payload) => {
    const result = annotateEvent(TRIM, payload, 5)
    expect(result).toHaveProperty('error')
    if (!('error' in result)) return
    expect(typeof result.error).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// apps#370 — host polish follow-ups
// ---------------------------------------------------------------------------

describe('completeIslandStep — clock injection (#370)', () => {
  it('stamps the caller-supplied `at` rather than reading the wall clock', () => {
    const result = completeIslandStep({ ...args('trim'), outputs: { pick: 'a' }, at: 42 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.at).toBe(42)
  })

  it('reads a submitted output named after an Object.prototype member by own key only', () => {
    const proto: Definition = toDefinition({
      name: 'Proto',
      jobs: {
        edit: {
          steps: [
            {
              id: 'trim',
              uses: 'island',
              with: { src: 'islands/a.html' },
              outputs: { constructor: { type: 'string' }, toString: { type: 'string' } },
            },
          ],
        },
      },
    })
    const step = proto.jobs.edit!.steps[0]!
    const base = { ...args('trim'), def: proto, step, at: 1 }

    const omitted = completeIslandStep({ ...base, outputs: {} })
    expect(omitted).toMatchObject({
      ok: true,
      event: { outputs: { constructor: null, toString: null } },
    })

    const given = completeIslandStep({ ...base, outputs: { constructor: 'c', toString: 't' } })
    expect(given).toMatchObject({
      ok: true,
      event: { outputs: { constructor: 'c', toString: 't' } },
    })
  })
})

describe('resolveSrc — must name a file (#370)', () => {
  it.each(['.', 'islands/', 'islands/.', '/w/studio/', '/w/studio/islands/'])(
    'rejects %j',
    (src) => {
      expect(() => resolveSrc('studio', src)).toThrow(/name a file/)
    },
  )
})

describe('annotateEvent — the per-step budget (#370)', () => {
  const one = (i: number) => ({ level: 'notice' as const, message: `m${i}` })

  it('exports the budget so the persistence layer can share it', () => {
    expect(ANNOTATION_BUDGET).toEqual({ count: 100, bytes: 64 * 1024, summaryBytes: 16 * 1024 })
  })

  it('accepts a call that lands exactly on the count cap', () => {
    const existing = Array.from({ length: 99 }, (_, i) => one(i))
    const result = annotateEvent(TRIM, { annotations: [one(99)] }, 5, existing)
    expect(result).not.toHaveProperty('error')
  })

  it('rejects a call that would exceed the count cap, counting what the step already holds', () => {
    const existing = Array.from({ length: 100 }, (_, i) => one(i))
    const result = annotateEvent(TRIM, { annotations: [one(100)] }, 5, existing)
    expect(result).toHaveProperty('error', expect.stringMatching(/at most 100/))
  })

  it('rejects a single call that alone exceeds the count cap', () => {
    const many = Array.from({ length: 101 }, (_, i) => one(i))
    expect(annotateEvent(TRIM, { annotations: many }, 5)).toHaveProperty('error')
  })

  it('rejects annotations whose serialised size, with what the step holds, exceeds the byte cap', () => {
    const big = { level: 'notice' as const, message: 'x'.repeat(40 * 1024) }
    expect(annotateEvent(TRIM, { annotations: [big] }, 5, [])).not.toHaveProperty('error')
    expect(annotateEvent(TRIM, { annotations: [big] }, 5, [big])).toHaveProperty(
      'error',
      expect.stringMatching(/64 KB/),
    )
  })

  it('rejects a summary over its own byte cap', () => {
    expect(annotateEvent(TRIM, { summary: 'x'.repeat(16 * 1024 + 1) }, 5)).toHaveProperty(
      'error',
      expect.stringMatching(/16 KB/),
    )
    expect(annotateEvent(TRIM, { summary: 'x'.repeat(16 * 1024) }, 5)).not.toHaveProperty(
      'error',
    )
  })
})
