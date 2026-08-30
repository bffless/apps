import { describe, expect, it, vi } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from './definition'
import type { Definition, FileRef } from './types'
import { coerceOutputs, OutputTypeError, REGISTER_CONCURRENCY, validateValue, type RegisterFile } from './outputs'

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

const smallDef: Definition = toDefinition({
  name: 'Small',
  jobs: {
    a: {
      steps: [
        {
          id: 's1',
          uses: 'pipeline',
          with: { path: 'echo' },
          outputs: { total: { type: 'number', value: '${{ response.total }}' } },
        },
      ],
      outputs: {},
    },
  },
  outputs: {},
})

function fakeRegisterFile(): { registerFile: RegisterFile; calls: string[] } {
  const calls: string[] = []
  const registerFile: RegisterFile = vi.fn(async (path: string): Promise<FileRef> => {
    calls.push(path)
    return { path, name: path.split('/').pop() ?? path, contentType: 'image/png', size: 42, url: `/api/uploads/${path}` }
  })
  return { registerFile, calls }
}

describe('coerceOutputs — say.line (string from response)', () => {
  it('coerces response.text to a string output', async () => {
    const decls = hello.jobs.greet!.steps.find((s) => s.id === 'say')!.raw.outputs
    const { registerFile } = fakeRegisterFile()
    const out = await coerceOutputs(decls, { response: { text: 'Hello, world!' } }, registerFile)
    expect(out).toEqual({ line: 'Hello, world!' })
  })
})

describe('coerceOutputs — start.poster (bare path → File ref)', () => {
  const decls = hello.jobs.slow!.steps.find((s) => s.id === 'start')!.raw.outputs

  it('registers a bare posterPath string and inserts the File ref', async () => {
    const { registerFile, calls } = fakeRegisterFile()
    const out = await coerceOutputs(
      decls,
      { response: { result: { markdown: '# hi', posterPath: 'workflows/hello/runs/r1/slow/0/start/poster.png' } } },
      registerFile,
    )
    expect(calls).toEqual(['workflows/hello/runs/r1/slow/0/start/poster.png'])
    expect(out.poster).toEqual({
      path: 'workflows/hello/runs/r1/slow/0/start/poster.png',
      name: 'poster.png',
      contentType: 'image/png',
      size: 42,
      url: '/api/uploads/workflows/hello/runs/r1/slow/0/start/poster.png',
    })
    expect(out.report).toBe('# hi')
  })

  it('passes a null poster through (no photo) without registering', async () => {
    const { registerFile, calls } = fakeRegisterFile()
    const out = await coerceOutputs(
      decls,
      { response: { result: { markdown: '# hi', posterPath: null } } },
      registerFile,
    )
    expect(out.poster).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('coerceOutputs — type mismatch', () => {
  it('throws OutputTypeError when a declared number receives a string', async () => {
    const { registerFile } = fakeRegisterFile()
    const decls = smallDef.jobs.a!.steps[0]!.raw.outputs
    await expect(
      coerceOutputs(decls, { response: { total: 'not a number' } }, registerFile),
    ).rejects.toThrow(OutputTypeError)
    await expect(
      coerceOutputs(decls, { response: { total: 'not a number' } }, registerFile),
    ).rejects.toMatchObject({ output: 'total', expected: 'number', got: 'not a number' })
  })
})

describe('coerceOutputs — validate before registering (apps#375)', () => {
  const mixedDef: Definition = toDefinition({
    name: 'Mixed',
    jobs: {
      a: {
        steps: [
          {
            id: 's1',
            uses: 'pipeline',
            with: { path: 'echo' },
            outputs: {
              poster: { type: 'file', value: '${{ response.posterPath }}' },
              total: { type: 'number', value: '${{ response.total }}' },
            },
          },
        ],
        outputs: {},
      },
    },
    outputs: {},
  })

  it('registers no file when a later-declared output fails its type check', async () => {
    const { registerFile, calls } = fakeRegisterFile()
    const decls = mixedDef.jobs.a!.steps[0]!.raw.outputs
    await expect(
      coerceOutputs(decls, { response: { posterPath: 'workflows/x/poster.png', total: 'nope' } }, registerFile),
    ).rejects.toMatchObject({ output: 'total', expected: 'number' })
    expect(calls).toEqual([])
  })
})

describe('coerceOutputs — omitted decls', () => {
  it('exposes only { response }', async () => {
    const { registerFile } = fakeRegisterFile()
    const out = await coerceOutputs(undefined, { response: { text: 'raw' } }, registerFile)
    expect(out).toEqual({ response: { text: 'raw' } })
  })

  it('defaults response to null when the context has none', async () => {
    const { registerFile } = fakeRegisterFile()
    const out = await coerceOutputs(undefined, {}, registerFile)
    expect(out).toEqual({ response: null })
  })
})

describe('coerceOutputs — table (decl columns + evaluated rows array)', () => {
  // studio.workflow.yaml's `scenes` output: value evaluates to a bare rows
  // array; `columns` lives on the decl, not the evaluated value (02).
  const decls = {
    scenes: {
      type: 'table',
      value: '${{ response.result.scenes }}',
      columns: [{ key: 'title' }, { key: 'start', type: 'number' }],
    },
  }

  it('assembles { columns, rows } from the decl columns + a bare rows array', async () => {
    const { registerFile } = fakeRegisterFile()
    const rows = [{ title: 'Intro', start: 0 }, { title: 'Body', start: 12 }]
    const out = await coerceOutputs(decls, { response: { result: { scenes: rows } } }, registerFile)
    expect(out.scenes).toEqual({
      columns: [{ key: 'title' }, { key: 'start', type: 'number' }],
      rows,
    })
  })

  it('passes an already { columns, rows }-shaped value through unchanged', async () => {
    const { registerFile } = fakeRegisterFile()
    const shaped = { columns: [{ key: 'x' }], rows: [{ x: 1 }] }
    const out = await coerceOutputs(decls, { response: { result: { scenes: shaped } } }, registerFile)
    expect(out.scenes).toEqual(shaped)
  })

  it('throws OutputTypeError when a table decl with columns receives a non-array', async () => {
    const { registerFile } = fakeRegisterFile()
    await expect(
      coerceOutputs(decls, { response: { result: { scenes: 'not a table' } } }, registerFile),
    ).rejects.toThrow(OutputTypeError)
  })
})

describe('validateValue — the closed vocabulary (02)', () => {
  it('validates each scalar type', () => {
    expect(validateValue('string', undefined, 'hi')).toBe(true)
    expect(validateValue('string', undefined, 3)).toBe(false)
    expect(validateValue('number', undefined, 3)).toBe(true)
    expect(validateValue('number', undefined, '3')).toBe(false)
    expect(validateValue('boolean', undefined, true)).toBe(true)
    expect(validateValue('boolean', undefined, 'true')).toBe(false)
    expect(validateValue('choice', undefined, 'world')).toBe(true)
    expect(validateValue('markdown', undefined, '# hi')).toBe(true)
    expect(validateValue('json', undefined, { anything: [1, 2] })).toBe(true)
    expect(validateValue('table', undefined, { columns: [{ key: 'a' }], rows: [{ a: 1 }] })).toBe(true)
    expect(validateValue('table', undefined, [1, 2])).toBe(false)
    expect(
      validateValue('file', undefined, {
        path: 'p', name: 'n', contentType: 'text/plain', size: 1, url: '/u',
      }),
    ).toBe(true)
    expect(validateValue('file', undefined, 'bare-path-not-a-ref')).toBe(false)
    // The strict reading is the shared shape guard (`./fileRef`, which only
    // promises path/name/url) *plus* contentType/size — a value that merely
    // names a file is not a `file` output (apps#379).
    expect(validateValue('file', undefined, { path: 'p', name: 'n', url: '/u' })).toBe(false)
  })

  it('wraps validation for list: true', () => {
    expect(validateValue('choice', true, ['world', 'studio'])).toBe(true)
    expect(validateValue('choice', true, ['world', 3])).toBe(false)
    expect(validateValue('string', true, 'not a list')).toBe(false)
  })

  it('passes null for any (non-required) slot', () => {
    expect(validateValue('number', undefined, null)).toBe(true)
    expect(validateValue('file', true, null)).toBe(true)
  })
})

describe('coerceOutputs — a list of files registers with bounded concurrency', () => {
  const decls = {
    frames: { type: 'file', list: true, value: '${{ response.result.paths }}' },
  } as unknown as Record<string, import('@bffless/workflow-lint/definition').OutputDecl>

  it(`never has more than ${REGISTER_CONCURRENCY} registrations in flight, and keeps declaration order`, async () => {
    const paths = Array.from({ length: 13 }, (_, i) => `workflows/x/frames/frame-${String(i + 1).padStart(3, '0')}.jpg`)
    let inFlight = 0
    let peak = 0
    const started: string[] = []
    // Every call parks until released, so the peak measures the *cap*, not the
    // speed of a fake that resolves before the next one is even started.
    const release: Array<() => void> = []
    const registerFile: RegisterFile = async (path) => {
      started.push(path)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => release.push(resolve))
      inFlight -= 1
      return { path, name: path.split('/').pop() ?? path, contentType: 'image/jpeg', size: 1, url: `/api/uploads/${path}` }
    }

    const pending = coerceOutputs(decls, { response: { result: { paths } } }, registerFile)
    // Let a wave start, check the cap, release one: exactly one more may start.
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    while (started.length < paths.length) {
      await tick()
      expect(inFlight).toBeLessThanOrEqual(REGISTER_CONCURRENCY)
      release.shift()?.()
    }
    await tick()
    while (release.length > 0) release.shift()?.()
    const out = await pending

    expect(peak).toBe(REGISTER_CONCURRENCY)
    expect(started).toEqual(paths)
    expect((out.frames as FileRef[]).map((f) => f.path)).toEqual(paths)
  })

  it('fails the whole list on the first registration error, and the error is the registrar\'s own', async () => {
    const paths = ['workflows/x/a.jpg', 'workflows/x/b.jpg']
    const registerFile: RegisterFile = async (path) => {
      if (path.endsWith('b.jpg')) throw new Error('registerFile workflows/x/b.jpg: files/register answered 500')
      return { path, name: 'a.jpg', contentType: 'image/jpeg', size: 1, url: `/api/uploads/${path}` }
    }
    await expect(coerceOutputs(decls, { response: { result: { paths } } }, registerFile)).rejects.toThrow(
      'registerFile workflows/x/b.jpg: files/register answered 500',
    )
  })
})
