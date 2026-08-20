import { describe, expect, it, vi } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from './definition'
import type { Definition, FileRef } from './types'
import { coerceOutputs, OutputTypeError, validateValue, type RegisterFile } from './outputs'

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
    return { path, name: path.split('/').pop() ?? path, contentType: 'image/png', size: 42, url: `/api/workflow/files/${path}` }
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
      url: '/api/workflow/files/workflows/hello/runs/r1/slow/0/start/poster.png',
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
