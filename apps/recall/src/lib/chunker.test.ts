import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

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

  // Chunk text is what gets embedded, so it must be transcript words and
  // nothing else. The chunker used to prepend a '[t=<sec>s] ' marker as an
  // interim timing carrier for CE instances that dropped chunk metadata
  // (pre-#652); that skewed every document vector by a token the query side
  // never had. Timing now rides exclusively in metadata, which is lossless
  // (float start AND end) where the marker was a rounded integer start.
  test('chunk text is transcript words only — no timing marker embedded', () => {
    const out = run({ words: words(400) })
    for (const c of out.chunks) {
      expect(c.text).not.toMatch(/\[t=\d+s\]/)
      expect(c.text.startsWith('w')).toBe(true) // fixture words are w0, w1, ...
    }
  })

  test('every chunk carries its start/end timing in metadata', () => {
    const out = run({ words: words(400) })
    for (const c of out.chunks) {
      expect(typeof c.metadata.start).toBe('number')
      expect(typeof c.metadata.end).toBe('number')
      expect(c.metadata.end).toBeGreaterThan(c.metadata.start)
    }
  })

  test('short tail merges into the previous chunk', () => {
    // NOTE: the brief's literal `words(130)` (default 0.5s/word gap) hits the
    // 45s time TARGET at 90 words -- before the 120-word MAXW cap -- so the
    // window closes by time, not by word count, and the remaining ~40 words
    // can never shrink below the 15-word MINW threshold no matter how the
    // overlap rewind is computed (rewinding only grows the tail further).
    // A slower 1s/word pace (45-word window, time-capped) leaves an 11-word
    // remainder after the overlap rewind -- genuinely below MINW=15 -- which
    // exercises the same merge branch without relying on the word-cap path
    // (whose overlap semantics are covered separately below). See
    // task-7-report.md for the full derivation, including why the
    // word-cap route can never produce a <15-word tail under the unified
    // restart formula (its floor guarantees >=96 words remain per window).
    const out = run({ words: words(46, 1) }) // 45-word window + 11-word tail
    expect(out.chunks.length).toBe(1)
  })

  test('word cap closes a window early, with bounded overlap into the next', () => {
    // Dense speech: 24s total, 240 words. MAXW/TARGET = 120/45s = 160 wpm --
    // an ordinary speaking rate -- so this isn't an exotic case: the time
    // target (45s) is never reached, every window closes on the 120-word cap,
    // and the unified restart formula floors each rewind at
    // (windowLen - OVERLAP_WORDS_CAP) = 120 - 24 = 96 words. That yields
    // windows at word indices 0-119, 96-215, 192-239 (verified against the fn
    // directly) -- 3 chunks, not 2, because each word-capped close still
    // carries a bounded ~24-word overlap into the next window instead of
    // resuming with none.
    const out = run({ words: words(240, 0.1) })
    expect(out.chunks.length).toBe(3)
  })

  test('word-capped windows advance by >=96 words with <=24-word overlap', () => {
    const gap = 0.1
    const out = run({ words: words(240, gap) })
    expect(out.chunks.length).toBeGreaterThanOrEqual(2)

    // The synthetic fixture spaces words evenly (start = index * gap), so a
    // chunk's word-index boundaries can be recovered from its timestamps:
    // startIdx = start / gap, and endIdx = (end - 0.4) / gap since each
    // word's own span is start..start+0.4.
    const toStartIdx = (start: number) => Math.round(start / gap)
    const toEndIdx = (end: number) => Math.round((end - 0.4) / gap)

    for (let i = 1; i < out.chunks.length; i++) {
      const prevStartIdx = toStartIdx(out.chunks[i - 1].metadata.start)
      const prevEndIdx = toEndIdx(out.chunks[i - 1].metadata.end)
      const curStartIdx = toStartIdx(out.chunks[i].metadata.start)

      expect(curStartIdx - prevStartIdx).toBeGreaterThanOrEqual(96) // >= MAXW - OVERLAP_WORDS_CAP
      expect(prevEndIdx - curStartIdx + 1).toBeLessThanOrEqual(24) // <= OVERLAP_WORDS_CAP
    }
  })

  test('a corrupt transcript reports a parse error without throwing', () => {
    const out = runFn(chunkFnSrc, {
      steps: { load: { records: [{ transcript: 'not json' }] } },
    }) as ChunkOutput & { error?: string }
    expect(out.error).toBe('TRANSCRIPT_PARSE_ERROR')
    expect(out.count).toBe(0)
    expect(out.chunks).toEqual([])
  })
})
