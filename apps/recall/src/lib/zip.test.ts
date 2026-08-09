import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type Chunk = { text: string; metadata: { start: number; end: number } }
type ZipOutput = { chunks: { embedding: number[]; text: string; metadata: unknown }[]; error?: string }

const zipFnSrc = loadFnSource('api/index/post/zip.fn.js')

function run(chunks: Chunk[], vectors: unknown): ZipOutput {
  return runFn(zipFnSrc, {
    steps: { chunk: { chunks }, embed: { output: vectors } },
  }) as ZipOutput
}

describe('zip.fn.js', () => {
  test('pairs each chunk with its same-index embedding', () => {
    const out = run([{ text: 'a', metadata: { start: 0, end: 4 } }], [[0.1, 0.2]])
    expect(out).toEqual({
      chunks: [{ embedding: [0.1, 0.2], text: 'a', metadata: { start: 0, end: 4 } }],
    })
  })

  test('pairs multiple chunks in order', () => {
    const out = run(
      [
        { text: 'a', metadata: { start: 0, end: 4 } },
        { text: 'b', metadata: { start: 4, end: 8 } },
      ],
      [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    )
    expect(out.chunks.map((c) => c.text)).toEqual(['a', 'b'])
    expect(out.chunks.map((c) => c.embedding)).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
  })

  test('a length mismatch reports EMBED_COUNT_MISMATCH without throwing', () => {
    const out = run(
      [
        { text: 'a', metadata: { start: 0, end: 4 } },
        { text: 'b', metadata: { start: 4, end: 8 } },
      ],
      [[0.1, 0.2]],
    )
    expect(out.error).toBe('EMBED_COUNT_MISMATCH')
    expect(out.chunks).toEqual([])
  })

  test('a missing embed step (e.g. the replicate call failed outright) is treated as a mismatch', () => {
    const out = runFn(zipFnSrc, {
      steps: { chunk: { chunks: [{ text: 'a', metadata: { start: 0, end: 4 } }] } },
    }) as ZipOutput
    expect(out.error).toBe('EMBED_COUNT_MISMATCH')
    expect(out.chunks).toEqual([])
  })

  test('vectors shaped as an array of strings (not number arrays) report EMBED_SHAPE_ERROR', () => {
    // Guards against the published OpenAPI schema's own `output` typing
    // (`array of string`) turning out to be literal, not a Cog schema-gen
    // quirk -- if the model ever really does hand back one string per text
    // instead of a float array, this must be rejected, not stored.
    const out = run([{ text: 'a', metadata: { start: 0, end: 4 } }], ['0.1,0.2'])
    expect(out.error).toBe('EMBED_SHAPE_ERROR')
    expect(out.chunks).toEqual([])
  })

  test('a vector whose first element is not a number reports EMBED_SHAPE_ERROR', () => {
    const out = run([{ text: 'a', metadata: { start: 0, end: 4 } }], [['0.1', '0.2']])
    expect(out.error).toBe('EMBED_SHAPE_ERROR')
    expect(out.chunks).toEqual([])
  })
})
