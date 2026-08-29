import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it, vi } from 'vitest'
import type { Definition, FileRef, RunState, Step, StepState } from '../types'
import { stepKey } from '../types'
import { OutputTypeError } from '../outputs'
import {
  blobFileName,
  coerceScriptOutputs,
  resolveScriptSrc,
  scriptAnnotateArgs,
  scriptInputs,
} from './script'

// ---------------------------------------------------------------------------
// Fixture — one job, one script step with an expression `with` key and two
// declared outputs (a `file` and a `number`), mirroring island.test.ts.
// ---------------------------------------------------------------------------

const def: Definition = toDefinition({
  name: 'Scripts',
  on: { manual: { inputs: { greeting: { type: 'string' } } } },
  jobs: {
    bundle: {
      steps: [
        {
          id: 'zip',
          uses: 'script',
          with: {
            src: 'scripts/bundle.js',
            markdown: '${{ inputs.greeting }}',
          },
          outputs: {
            zip: { type: 'file' },
            n: { type: 'number' },
          },
        },
        {
          id: 'zips',
          uses: 'script',
          with: { src: 'scripts/bundle.js' },
          outputs: {
            zip: { type: 'file', list: true },
          },
        },
        // A non-file output mix, for the presence-vs-blank tests: a script's
        // `''`/`0`/`false` are answers, not unanswered fields.
        {
          id: 'meta',
          uses: 'script',
          with: { src: 'scripts/bundle.js' },
          outputs: {
            text: { type: 'string' },
            count: { type: 'number' },
            flag: { type: 'boolean' },
          },
        },
        // Same step minus the expression `with` key — nothing else to strip but `src`.
        {
          id: 'bare',
          uses: 'script',
          with: { src: 'scripts/bare.js' },
        },
      ],
    },
  },
})

function stepOf(id: string): Step {
  const step = def.jobs.bundle?.steps.find((s) => s.id === id)
  if (!step) throw new Error(`no such step ${id}`)
  return step
}

function stepState(stepId: string, over: Partial<StepState> = {}): StepState {
  return {
    key: stepKey('bundle', 0, stepId),
    job: 'bundle',
    index: 0,
    stepId,
    kind: 'script',
    status: 'running',
    attempt: 1,
    annotations: [],
    ...over,
  }
}

function state(): RunState {
  return {
    runId: 'run_TEST',
    impl: 'hello',
    workflow: 'scripts',
    status: 'running',
    headless: false,
    unattended: false,
    inputs: { greeting: 'hi' },
    steps: { [stepKey('bundle', 0, 'zip')]: stepState('zip') },
    expansions: { bundle: { total: 1, items: [{}] } },
    annotations: [],
    startedAt: 1_000,
  }
}

function args(stepId: string) {
  return {
    step: stepOf(stepId),
    key: stepKey('bundle', 0, stepId),
    job: 'bundle',
    index: 0,
    def,
    state: state(),
  }
}

function fileRef(over: Partial<FileRef> = {}): FileRef {
  return {
    path: 'workflows/hello/scripts/runs/run_TEST/bundle/0/zip/out.zip',
    name: 'out.zip',
    contentType: 'application/zip',
    size: 1,
    url: '/api/uploads/workflows/hello/scripts/runs/run_TEST/bundle/0/zip/out.zip',
    ...over,
  }
}

// ---------------------------------------------------------------------------
// scriptInputs
// ---------------------------------------------------------------------------

describe('scriptInputs', () => {
  it('evaluates `with` and strips `src` off the module inputs', () => {
    const { src, inputs } = scriptInputs(args('zip'))

    expect(src).toBe('scripts/bundle.js')
    expect(inputs).toEqual({ markdown: 'hi' })
  })

  it('leaves an empty inputs object when `with` has nothing but `src`', () => {
    const { src, inputs } = scriptInputs(args('bare'))

    expect(src).toBe('scripts/bare.js')
    expect(inputs).toEqual({})
  })

  it('throws when `src` is missing (a definition bug the linter should have caught)', () => {
    const a = args('zip')
    const step: Step = { ...a.step, raw: { ...a.step.raw, with: { markdown: 'hi' } } }
    expect(() => scriptInputs({ ...a, step })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// blobFileName
// ---------------------------------------------------------------------------

describe('blobFileName', () => {
  it("uses a File's own name", () => {
    const file = new File(['x'], 'take.mov', { type: 'video/quicktime' })
    expect(blobFileName('zip', file)).toBe('take.mov')
  })

  it('names a bare Blob after the output plus an extension guessed from its MIME type', () => {
    expect(blobFileName('zip', new Blob(['x'], { type: 'application/zip' }))).toBe('zip.zip')
    expect(blobFileName('poster', new Blob(['x'], { type: 'image/png' }))).toBe('poster.png')
  })

  it('falls back to .bin for an unknown or empty MIME type', () => {
    expect(blobFileName('out', new Blob(['x'], { type: 'application/x-nonsense' }))).toBe('out.bin')
    expect(blobFileName('out', new Blob(['x']))).toBe('out.bin')
  })
})

// ---------------------------------------------------------------------------
// coerceScriptOutputs
// ---------------------------------------------------------------------------

describe('coerceScriptOutputs', () => {
  function deps() {
    return {
      uploadBlob: vi.fn(async (_blob: Blob, name: string) => fileRef({ name })),
      registerFile: vi.fn(async (path: string) => fileRef({ path, name: path.split('/').pop() ?? path })),
    }
  }

  it('uploads a returned Blob for a `file` output and returns the ref', async () => {
    const d = deps()
    const blob = new Blob(['x'], { type: 'application/zip' })

    const outputs = await coerceScriptOutputs(args('zip'), { zip: blob, n: 1 }, d)

    expect(d.uploadBlob).toHaveBeenCalledTimes(1)
    expect(d.uploadBlob).toHaveBeenCalledWith(blob, 'zip.zip')
    expect(outputs.zip).toEqual(fileRef({ name: 'zip.zip' }))
    expect(outputs.n).toBe(1)
  })

  it("keeps a returned File's own name", async () => {
    const d = deps()
    const file = new File(['x'], 'take.mov', { type: 'video/quicktime' })

    const outputs = await coerceScriptOutputs(args('zip'), { zip: file, n: 1 }, d)

    expect(d.uploadBlob).toHaveBeenCalledWith(file, 'take.mov')
    expect(outputs.zip).toEqual(fileRef({ name: 'take.mov' }))
  })

  it('registers a returned string path for a `file` output', async () => {
    const d = deps()

    const outputs = await coerceScriptOutputs(
      args('zip'),
      { zip: 'workflows/hello/scripts/runs/run_TEST/bundle/0/zip/x.zip', n: 1 },
      d,
    )

    expect(d.registerFile).toHaveBeenCalledWith(
      'workflows/hello/scripts/runs/run_TEST/bundle/0/zip/x.zip',
    )
    expect(d.uploadBlob).not.toHaveBeenCalled()
    expect(outputs.zip).toEqual(fileRef({ path: 'workflows/hello/scripts/runs/run_TEST/bundle/0/zip/x.zip', name: 'x.zip' }))
  })

  it('throws OutputTypeError when a `file` output comes back a wrong-shaped value', async () => {
    const d = deps()

    await expect(coerceScriptOutputs(args('zip'), { zip: 42, n: 1 }, d)).rejects.toThrow(
      OutputTypeError,
    )
    expect(d.uploadBlob).not.toHaveBeenCalled()
    expect(d.registerFile).not.toHaveBeenCalled()
  })

  it('uploads a `list: true` file output in order', async () => {
    const d = deps()
    const a = new Blob(['a'], { type: 'application/zip' })
    const b = new Blob(['b'], { type: 'application/zip' })

    const outputs = await coerceScriptOutputs(args('zips'), { zip: [a, b] }, d)

    expect(d.uploadBlob).toHaveBeenCalledTimes(2)
    expect(d.uploadBlob.mock.calls[0]).toEqual([a, 'zip.zip'])
    expect(d.uploadBlob.mock.calls[1]).toEqual([b, 'zip.zip'])
    expect(outputs.zip).toEqual([fileRef({ name: 'zip.zip' }), fileRef({ name: 'zip.zip' })])
  })

  it('throws OutputTypeError when a declared output is missing from the return value', async () => {
    const d = deps()

    await expect(coerceScriptOutputs(args('zip'), { zip: new Blob(['x']) }, d)).rejects.toThrow(
      OutputTypeError,
    )
  })

  it('validates every non-file output before uploading anything, so a later type failure leaves no orphan bytes (apps#375)', async () => {
    const d = deps()

    await expect(
      coerceScriptOutputs(args('zip'), { zip: new Blob(['x'], { type: 'application/zip' }), n: 'not a number' }, d),
    ).rejects.toMatchObject({ output: 'n', expected: 'number' })
    expect(d.uploadBlob).not.toHaveBeenCalled()
  })

  it('names the declared type, not a sentence, as `expected` for a missing output (apps#375)', async () => {
    const d = deps()

    await expect(coerceScriptOutputs(args('zip'), { zip: new Blob(['x']) }, d)).rejects.toMatchObject({
      output: 'n',
      expected: 'number',
      got: null,
    })
    await expect(coerceScriptOutputs(args('zips'), {}, d)).rejects.toMatchObject({
      output: 'zip',
      expected: 'file[]',
    })
  })

  it('throws OutputTypeError when the module returns nothing at all', async () => {
    const d = deps()

    await expect(coerceScriptOutputs(args('zip'), undefined, d)).rejects.toThrow(OutputTypeError)
    expect(d.uploadBlob).not.toHaveBeenCalled()
  })

  it("accepts '' for a declared `string` output — a script's blank is an answer, not unanswered (live fix)", async () => {
    const d = deps()

    const outputs = await coerceScriptOutputs(
      args('meta'),
      { text: '', count: 1, flag: true },
      d,
    )

    expect(outputs.text).toBe('')
  })

  it('accepts `0`/`false` for declared `number`/`boolean` outputs', async () => {
    const d = deps()

    const outputs = await coerceScriptOutputs(
      args('meta'),
      { text: 'hi', count: 0, flag: false },
      d,
    )

    expect(outputs.count).toBe(0)
    expect(outputs.flag).toBe(false)
  })

  it('throws OUTPUT_TYPE for a declared output the module never set', async () => {
    const d = deps()

    await expect(
      coerceScriptOutputs(args('meta'), { count: 1, flag: true }, d),
    ).rejects.toMatchObject({ output: 'text', expected: 'string', got: null })
  })

  it('throws OUTPUT_TYPE for a declared output explicitly returned `undefined`', async () => {
    const d = deps()

    await expect(
      coerceScriptOutputs(args('meta'), { text: undefined, count: 1, flag: true }, d),
    ).rejects.toMatchObject({ output: 'text', expected: 'string', got: null })
  })
})

describe('resolveScriptSrc', () => {
  it('scopes a relative src to the implementation bundle', () => {
    expect(resolveScriptSrc('hello', 'scripts/bundle.js')).toBe('/w/hello/scripts/bundle.js')
    expect(resolveScriptSrc('hello', '/w/hello/scripts/bundle.js')).toBe('/w/hello/scripts/bundle.js')
  })

  it('refuses anything that leaves it, and says `script` when it does', () => {
    for (const src of ['../other/steal.js', '/w/other/steal.js', 'https://evil.example/x.js', '/api/hello/x']) {
      expect(() => resolveScriptSrc('hello', src)).toThrow(/^script src /)
    }
  })
})

describe('scriptAnnotateArgs', () => {
  it('lifts the module contract\'s single annotation into the row shape', () => {
    expect(scriptAnnotateArgs({ level: 'notice', message: 'card drawn' })).toEqual({
      annotations: [{ level: 'notice', message: 'card drawn' }],
    })
    expect(scriptAnnotateArgs({ level: 'warning', message: 'slow', title: 'Render' })).toEqual({
      annotations: [{ level: 'warning', message: 'slow', title: 'Render' }],
    })
  })

  it('passes a summary-only call, the row shape and nonsense straight through', () => {
    // `annotateEvent` is the only validator either path has — it must be the
    // one that answers these, not a second set of rules here.
    expect(scriptAnnotateArgs({ summary: 'half way' })).toEqual({ summary: 'half way' })
    expect(scriptAnnotateArgs({ annotations: 'not a list' })).toEqual({ annotations: 'not a list' })
    expect(scriptAnnotateArgs({})).toEqual({})
    expect(scriptAnnotateArgs('nope')).toBe('nope')
    expect(scriptAnnotateArgs(null)).toBe(null)
  })
})
