import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from './fnHarness'

type Word = { text: string; start: number; end: number }
type Chunk = { text: string; metadata: { start: number; end: number } }
type ChunkOutput = { count: number; chunks: Chunk[] }

const chunkFnSrc = loadFnSource('api/index/post/chunk.fn.js')

function run(transcript: { words: Word[] }): ChunkOutput {
  return runFn(chunkFnSrc, {
    steps: { load: { records: [{ transcript: JSON.stringify(transcript) }] } },
  }) as ChunkOutput
}

const words = (n: number, gap = 0.5): Word[] =>
  Array.from({ length: n }, (_, i) => ({ text: `w${i}`, start: i * gap, end: i * gap + 0.4 }))

describe('chunk.fn.js', () => {
  test('splits a 200s stream into overlapping ~45s windows', () => {
    const out = run({ words: words(400) }) // 400 words * 0.5s = 200s
    expect(out.chunks.length).toBeGreaterThanOrEqual(4)
    for (let i = 1; i < out.chunks.length; i++) {
      expect(out.chunks[i].metadata.start).toBeLessThanOrEqual(
        out.chunks[i - 1].metadata.end - 5, // overlap exists
      )
    }
  })

  test('every chunk text starts with its [t=Ns] prefix', () => {
    const out = run({ words: words(400) })
    for (const c of out.chunks) {
      expect(c.text).toMatch(new RegExp(`^\\[t=${Math.round(c.metadata.start)}s\\] `))
    }
  })

  test('short tail merges into the previous chunk', () => {
    // NOTE: the brief's literal `words(130)` (default 0.5s/word gap) hits the
    // 45s time TARGET at 90 words -- before the 120-word MAXW cap -- so the
    // window closes by time, not by word count, and the remaining ~40 words
    // can never shrink below the 15-word MINW threshold no matter how the
    // overlap rewind is computed (rewinding only grows the tail further).
    // 120 (MAXW) + 10 (< MINW) = 130 makes it clear the fixture intended the
    // word-cap branch to fire; that requires a denser pace than the helper's
    // default. Using 0.3s/word here (120 words * 0.3s = 36s < TARGET) is the
    // minimal fix to realize the test's own documented intent. See
    // task-7-report.md for the full derivation.
    const out = run({ words: words(130, 0.3) }) // 120-word window + 10-word tail
    expect(out.chunks.length).toBe(1)
  })

  test('word cap closes a window before the time target', () => {
    const out = run({ words: words(240, 0.1) }) // dense speech: 24s total, 240 words
    expect(out.chunks.length).toBe(2) // split by maxWords, not time
  })
})
