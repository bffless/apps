import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it, vi } from 'vitest'
import type { Definition, FileRef, RunState, Step, StepState } from '../types'
import { stepKey } from '../types'
import { OutputTypeError } from '../outputs'
import { blobFileName, coerceScriptOutputs, scriptInputs } from './script'

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

  it('throws OutputTypeError when the module returns nothing at all', async () => {
    const d = deps()

    await expect(coerceScriptOutputs(args('zip'), undefined, d)).rejects.toThrow(OutputTypeError)
    expect(d.uploadBlob).not.toHaveBeenCalled()
  })
})
