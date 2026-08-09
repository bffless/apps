import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type PrepOutput = { videoId: string; chunks: unknown[]; sheetsPrefix: string; sheetsSubDir: string }

const prepFnSrc = loadFnSource('api/unpublish/post/prep.fn.js')

function run(body: unknown): PrepOutput {
  return runFn(prepFnSrc, { request: { body } }) as PrepOutput
}

describe('api/unpublish/post/prep.fn.js', () => {
  test('normalizes videoId, hands embed_store a real empty array, and builds the sheets prefix/sub_dir', () => {
    expect(run({ videoId: 'v1' })).toEqual({
      videoId: 'v1',
      chunks: [],
      sheetsPrefix: 'sheets/v1/',
      sheetsSubDir: 'sheets/v1',
    })
  })

  test('chunks is a real array, not the string "[]"', () => {
    const out = run({ videoId: 'v1' })
    expect(Array.isArray(out.chunks)).toBe(true)
    expect(out.chunks).toHaveLength(0)
  })

  test('the sheets prefix is top-level (no videos/ nesting) and has a trailing slash; the sub_dir does not', () => {
    const out = run({ videoId: 'v1' })
    expect(out.sheetsPrefix).toBe('sheets/v1/')
    expect(out.sheetsSubDir).toBe('sheets/v1')
    expect(out.sheetsSubDir.endsWith('/')).toBe(false)
  })

  test('trims whitespace around videoId', () => {
    expect(run({ videoId: '  v1  ' })).toEqual({
      videoId: 'v1',
      chunks: [],
      sheetsPrefix: 'sheets/v1/',
      sheetsSubDir: 'sheets/v1',
    })
  })

  // PR-feedback-4: throws (fails closed) instead of silently no-op-ing on a
  // missing videoId, now that this rule runs a PREFIX-based file_delete —
  // an empty id would resolve to the top-level 'sheets/' prefix, wiping
  // every video's sheet, not just this one's.
  test('throws when videoId is missing or blank', () => {
    expect(() => run({})).toThrow('videoId required')
    expect(() => run({ videoId: '' })).toThrow('videoId required')
    expect(() => run({ videoId: '   ' })).toThrow('videoId required')
    expect(() => run(undefined)).toThrow('videoId required')
  })
})
