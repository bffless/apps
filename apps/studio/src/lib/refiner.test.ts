import { describe, it, expect } from 'vitest'
import {
  toRefinement,
  effectiveCuts,
  keptSpans,
  keptWords,
  sceneTail,
  normalizeCuts,
  addCut,
  removeCut,
  refineDirections,
  sceneWordTimings,
  type RefineSceneRaw,
} from './refiner'
import type { Scene } from './scenes'
import type { TWord } from './transcriptGrid'

/** A minimal scene spanning [start, end] with a director first-pass cut. */
function scene(partial: Partial<Scene> = {}): Scene {
  return {
    id: 'scene-1',
    index: 0,
    sourceId: 'source-1',
    title: 'Scene 1',
    start: 0,
    end: 100,
    transcript: 'the director first pass script',
    status: 'pending',
    cuts: [{ start: 40, end: 50 }],
    ...partial,
  }
}

describe('toRefinement', () => {
  it('coerces cuts and tags the source ai', () => {
    const raw: RefineSceneRaw = { cuts: [{ start: 35, end: 52 }] }
    const r = toRefinement(raw, scene())
    expect(r).toEqual({ cuts: [{ start: 35, end: 52 }], source: 'ai' })
  })

  it('clamps cuts into the scene span', () => {
    const r = toRefinement({ cuts: [{ start: -10, end: 30 }] }, scene({ start: 0, end: 100 }))
    expect(r.cuts).toEqual([{ start: 0, end: 30 }])
  })

  it('normalizes the cut set (sorted, merged, slivers dropped)', () => {
    const r = toRefinement(
      { cuts: [{ start: 20, end: 30 }, { start: 0, end: 20 }, { start: 60, end: 60.02 }] },
      scene(),
    )
    expect(r.cuts).toEqual([{ start: 0, end: 30 }])
  })

  it('ignores legacy narration segments on the wire', () => {
    const raw = {
      cuts: [{ start: 1, end: 2 }],
      segments: [{ text: 'old narration', start: 0, end: 30 }],
    } as RefineSceneRaw
    expect(toRefinement(raw, scene())).toEqual({ cuts: [{ start: 1, end: 2 }], source: 'ai' })
  })

  it('defaults to an empty cut set for a junk response', () => {
    const r = toRefinement({} as RefineSceneRaw, scene())
    expect(r).toEqual({ cuts: [], source: 'ai' })
  })
})

describe('effectiveCuts', () => {
  it('uses the refinement when present', () => {
    const refined = { cuts: [{ start: 1, end: 2 }], source: 'ai' as const }
    expect(effectiveCuts(scene({ refined }))).toBe(refined.cuts)
  })

  it('falls back to the director cuts when not refined', () => {
    expect(effectiveCuts(scene())).toEqual([{ start: 40, end: 50 }])
  })

  it('reverting to refined=null restores the director baseline', () => {
    expect(effectiveCuts(scene({ refined: null }))).toEqual([{ start: 40, end: 50 }])
  })
})

describe('keptSpans', () => {
  it('is the complement of the cuts within the window', () => {
    expect(keptSpans([{ start: 10, end: 30 }, { start: 60, end: 80 }], 0, 100)).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 60 },
      { start: 80, end: 100 },
    ])
  })

  it('is the whole window when there are no cuts', () => {
    expect(keptSpans([], 5, 50)).toEqual([{ start: 5, end: 50 }])
  })

  it('is empty when a cut covers the whole window', () => {
    expect(keptSpans([{ start: 0, end: 100 }], 10, 90)).toEqual([])
  })

  it('normalizes overlapping cuts and clamps them to the window', () => {
    expect(keptSpans([{ start: -5, end: 20 }, { start: 15, end: 40 }], 0, 100)).toEqual([
      { start: 40, end: 100 },
    ])
  })

  it('drops sub-0.05s kept slivers between adjacent cuts', () => {
    expect(keptSpans([{ start: 0, end: 50 }, { start: 50.02, end: 100 }], 0, 100)).toEqual([])
  })
})

describe('keptWords', () => {
  const words: TWord[] = [
    { text: 'keep', start: 0, end: 1 },
    { text: 'cut', start: 10, end: 11 },
    { text: 'also', start: 30, end: 31 },
  ]

  it('drops words whose midpoint falls inside a cut', () => {
    expect(keptWords(words, [{ start: 9, end: 12 }]).map((w) => w.text)).toEqual(['keep', 'also'])
  })

  it('keeps everything with no cuts', () => {
    expect(keptWords(words, [])).toEqual(words)
  })

  it('keeps a word whose midpoint sits exactly at a cut end', () => {
    // word 10–11 (mid 10.5); cut ends at 10.5 — half-open, so the word survives
    expect(keptWords(words, [{ start: 9, end: 10.5 }]).map((w) => w.text)).toEqual([
      'keep',
      'cut',
      'also',
    ])
  })
})

describe('sceneTail (story 03r)', () => {
  const words: TWord[] = [
    { text: 'one', start: 0, end: 1 },
    { text: 'two', start: 2, end: 3 },
    { text: 'flub', start: 4, end: 5 },
    { text: 'three', start: 6, end: 7 },
    { text: 'four', start: 8, end: 9 },
  ]

  it('returns the last kept words after the effective cuts', () => {
    const s = scene({ cuts: [{ start: 3.5, end: 5.5 }] })
    expect(sceneTail(s, words, 3)).toBe('two three four')
  })

  it('falls back to the transcript tail when no words are given', () => {
    const s = scene({ transcript: 'one two three four five six' })
    expect(sceneTail(s, [], 3)).toBe('four five six')
  })

  it('returns the whole text when it is shorter than maxWords', () => {
    const s = scene({ transcript: 'just three words' })
    expect(sceneTail(s, [], 30)).toBe('just three words')
  })

  it('returns empty string for an empty scene', () => {
    const s = scene({ transcript: '   ', refined: null, cuts: [] })
    expect(sceneTail(s)).toBe('')
  })
})

describe('normalizeCuts', () => {
  it('sorts, drops slivers, and coalesces touching/overlapping spans', () => {
    expect(
      normalizeCuts([
        { start: 13, end: 24 },
        { start: 0, end: 9 },
        { start: 9, end: 13 }, // bridges the first two → all three merge
        { start: 60, end: 60.02 }, // sub-cell sliver → dropped
        { start: 43, end: 53 },
      ]),
    ).toEqual([
      { start: 0, end: 24 },
      { start: 43, end: 53 },
    ])
  })
})

describe('addCut', () => {
  const sc = { start: 0, end: 100 }

  it('adds a brand-new cut over kept footage', () => {
    expect(addCut([{ start: 0, end: 9 }], { start: 30, end: 40 }, sc)).toEqual([
      { start: 0, end: 9 },
      { start: 30, end: 40 },
    ])
  })

  it('extends an existing cut when the new span is adjacent', () => {
    // the 9–13 dead air between two cuts, added → the three collapse to one
    expect(
      addCut([{ start: 0, end: 9 }, { start: 13, end: 24 }], { start: 9, end: 13 }, sc),
    ).toEqual([{ start: 0, end: 24 }])
  })

  it('clamps the added span to the scene span', () => {
    expect(addCut([], { start: 90, end: 200 }, sc)).toEqual([{ start: 90, end: 100 }])
  })

  it('ignores a span that clamps to nothing', () => {
    expect(addCut([{ start: 0, end: 9 }], { start: 200, end: 300 }, sc)).toEqual([
      { start: 0, end: 9 },
    ])
  })
})

describe('removeCut', () => {
  it('contracts a cut from its edge', () => {
    expect(removeCut([{ start: 0, end: 9 }], { start: 5, end: 9 })).toEqual([
      { start: 0, end: 5 },
    ])
  })

  it('splits a cut when the removal carves out the middle', () => {
    expect(removeCut([{ start: 0, end: 20 }], { start: 8, end: 12 })).toEqual([
      { start: 0, end: 8 },
      { start: 12, end: 20 },
    ])
  })

  it('drops a fully-covered cut and leaves others untouched', () => {
    expect(
      removeCut([{ start: 13, end: 24 }, { start: 43, end: 53 }], { start: 10, end: 30 }),
    ).toEqual([{ start: 43, end: 53 }])
  })
})

describe('refineDirections (story 03l)', () => {
  it('sends the trimmed per-scene prompt and the trimmed global direction by default', () => {
    expect(refineDirections({ refinePrompt: '  trim the pause  ' }, '  punchy intro  ')).toEqual({
      direction: 'trim the pause',
      directorDirection: 'punchy intro',
    })
  })

  it('defaults both to empty strings when nothing is set', () => {
    expect(refineDirections({}, '')).toEqual({ direction: '', directorDirection: '' })
  })

  it('treats an absent includeDirection as include (default checked)', () => {
    expect(refineDirections({ includeDirection: undefined }, 'punchy')).toEqual({
      direction: '',
      directorDirection: 'punchy',
    })
  })

  it('excludes the director prompt when includeDirection is false', () => {
    expect(refineDirections({ refinePrompt: 'keep the code', includeDirection: false }, 'punchy')).toEqual({
      direction: 'keep the code',
      directorDirection: '',
    })
  })

  it('whitespace-only global direction sends empty regardless of the checkbox', () => {
    expect(refineDirections({ includeDirection: true }, '   ')).toEqual({
      direction: '',
      directorDirection: '',
    })
  })
})

describe('sceneWordTimings (story 03p)', () => {
  it('emits one `start end word` line per word, 2 decimals, in order', () => {
    const out = sceneWordTimings([
      { text: 'In', start: 11.5, end: 11.7 },
      { text: 'this', start: 11.8, end: 12.04 },
      { text: 'session', start: 12.1, end: 12.5 },
    ])
    expect(out).toBe('11.50 11.70 In\n11.80 12.04 this\n12.10 12.50 session')
  })

  it('skips words with no finite start and trims the text', () => {
    const out = sceneWordTimings([
      { text: '  hello ', start: 1, end: 1.3 },
      { text: 'dropped', start: NaN as unknown as number, end: 2 },
      { text: 'world', start: 3.2, end: 3.9 },
    ])
    expect(out).toBe('1.00 1.30 hello\n3.20 3.90 world')
  })

  it('falls back to start for a missing end and returns "" for no words', () => {
    expect(sceneWordTimings([{ text: 'x', start: 5 } as unknown as { text: string; start: number; end: number }])).toBe(
      '5.00 5.00 x',
    )
    expect(sceneWordTimings([])).toBe('')
  })
})
