import { describe, it, expect } from 'vitest'
import {
  toRefinement,
  effectiveSegments,
  effectiveCuts,
  sceneTail,
  segmentsToTimedWords,
  normalizeCuts,
  addCut,
  removeCut,
  gaps,
  fitsGap,
  clampDropStart,
  moveRun,
  overlaps,
  insertSegment,
  removeSegment,
  voicingSummary,
  suggestedOriginalIndices,
  applyOriginalClips,
  refineDirections,
  sceneWordTimings,
  type RefineSceneRaw,
  type RefineSegment,
} from './refiner'
import type { NarrationSegment } from './scenes'
import type { Scene } from './scenes'

/** A minimal scene spanning [start, end] with a director first-pass draft/cuts. */
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
    narrationSeconds: null,
    cuts: [{ start: 40, end: 50 }],
    ...partial,
  }
}

describe('toRefinement', () => {
  it('coerces segments + cuts and tags the source ai', () => {
    const raw: RefineSceneRaw = {
      segments: [
        { text: 'first run of new narration', start: 0, end: 30 },
        { text: 'second run after a pause', start: 55, end: 90 },
      ],
      cuts: [{ start: 35, end: 52 }],
    }
    const r = toRefinement(raw, scene())
    expect(r.source).toBe('ai')
    expect(r.segments).toEqual([
      { text: 'first run of new narration', start: 0, end: 30 },
      { text: 'second run after a pause', start: 55, end: 90 },
    ])
    expect(r.cuts).toEqual([{ start: 35, end: 52 }])
  })

  it('clamps segments + cuts into the scene span', () => {
    const raw: RefineSceneRaw = {
      segments: [{ text: 'spills past the end', start: 90, end: 200 }],
      cuts: [{ start: -10, end: 30 }],
    }
    const r = toRefinement(raw, scene({ start: 0, end: 100 }))
    expect(r.segments[0]).toMatchObject({ start: 90, end: 100 })
    expect(r.cuts[0]).toEqual({ start: 0, end: 30 })
  })

  it('sorts segments ascending and forces them non-overlapping', () => {
    const raw: RefineSceneRaw = {
      segments: [
        { text: 'later', start: 40, end: 80 },
        { text: 'earlier', start: 0, end: 50 }, // overlaps the later one
      ],
    }
    const r = toRefinement(raw, scene())
    expect(r.segments.map((s) => s.text)).toEqual(['earlier', 'later'])
    // 'later' start snapped up to 'earlier' end so they don't overlap
    expect(r.segments[1].start).toBe(50)
  })

  it('drops empty-text and zero-length segments', () => {
    const raw: RefineSceneRaw = {
      segments: [
        { text: '   ', start: 0, end: 10 },
        { text: 'real', start: 10, end: 10.02 }, // collapses (<0.05)
        { text: 'kept', start: 20, end: 40 },
      ],
    }
    const r = toRefinement(raw, scene())
    expect(r.segments).toEqual([{ text: 'kept', start: 20, end: 40 }])
  })

  it('defaults to empty arrays for a junk response', () => {
    const r = toRefinement({} as RefineSceneRaw, scene())
    expect(r).toEqual({ segments: [], cuts: [], source: 'ai' })
  })
})

describe('toRefinement voicing source (story 03j, trust-the-tag 03o)', () => {
  it("trusts an 'original' tag — the text is a label, never re-checked against the transcript", () => {
    // The model's echo can differ from WhisperX (a colloquial spelling like
    // "gonna" vs "going to", a dropped filler) yet still describe the same audio.
    // 03o stopped second-guessing the tag: 'original' passes straight through
    // with the model's own span; no verbatim gate, no snap, no downgrade.
    const r = toRefinement(
      { segments: [{ text: "In this session I'm gonna be going over onboarding rules.", start: 11.5, end: 15, source: 'original' }] },
      scene(),
    )
    expect(r.segments[0].suggestedSource).toBe('original')
    expect(r.segments[0].start).toBe(11.5)
    expect(r.segments[0].end).toBe(15)
  })

  it("passes 'revoice' through and drops junk source values", () => {
    const r = toRefinement(
      {
        segments: [
          { text: 'a new line', start: 0, end: 5, source: 'revoice' },
          { text: 'another line', start: 20, end: 25, source: 'shout' as unknown as RefineSegment['source'] },
        ],
      },
      scene(),
    )
    expect(r.segments[0].suggestedSource).toBe('revoice')
    expect(r.segments[1].suggestedSource).toBeUndefined()
    // the key is genuinely ABSENT for junk values, not set to undefined
    expect(r.segments.map((s) => 'suggestedSource' in s)).toEqual([true, false])
  })

  it("keeps the 'original' tag even when the cursor clamp shifts the span (no downgrade)", () => {
    // The first segment ends at 10.6, so the second is cursor-clamped to start
    // there. We no longer downgrade on the resulting span drift — the tag stands
    // and the clamped span is what plays.
    const r = toRefinement(
      {
        segments: [
          { text: 'So', start: 10, end: 10.6 },
          { text: 'so the idea is', start: 10, end: 12.5, source: 'original' },
        ],
      },
      scene(),
    )
    expect(r.segments[1].suggestedSource).toBe('original')
    expect(r.segments[1].start).toBe(10.6)
  })
})

describe('effectiveSegments / effectiveCuts', () => {
  it('uses the refinement when present', () => {
    const refined = { segments: [{ text: 'new', start: 5, end: 9 }], cuts: [{ start: 1, end: 2 }], source: 'ai' as const }
    const s = scene({ refined })
    expect(effectiveSegments(s)).toBe(refined.segments)
    expect(effectiveCuts(s)).toBe(refined.cuts)
  })

  it('falls back to one transcript segment + director cuts when not refined', () => {
    const s = scene({ start: 0, end: 100, transcript: 'fallback', cuts: [{ start: 40, end: 50 }] })
    expect(effectiveSegments(s)).toEqual([{ text: 'fallback', start: 0, end: 100 }])
    expect(effectiveCuts(s)).toEqual([{ start: 40, end: 50 }])
  })

  it('reverting to refined=null restores the director baseline', () => {
    const s = scene({ refined: null })
    expect(effectiveSegments(s)).toEqual([{ text: 'the director first pass script', start: 0, end: 100 }])
    expect(effectiveCuts(s)).toEqual([{ start: 40, end: 50 }])
  })
})

describe('sceneTail (story 03r)', () => {
  it('returns the last words of the refined narration when refined', () => {
    const refined = {
      segments: [
        { text: 'first run here', start: 0, end: 5 },
        { text: 'and the second run ends the scene', start: 6, end: 12 },
      ],
      cuts: [],
      source: 'ai' as const,
    }
    const s = scene({ refined })
    expect(sceneTail(s, 4)).toBe('run ends the scene')
  })

  it('falls back to the transcript tail when not refined', () => {
    const s = scene({ transcript: 'one two three four five six' })
    expect(sceneTail(s, 3)).toBe('four five six')
  })

  it('returns the whole text when it is shorter than maxWords', () => {
    const s = scene({ transcript: 'just three words' })
    expect(sceneTail(s, 30)).toBe('just three words')
  })

  it('joins multiple refined segments before taking the tail', () => {
    const refined = {
      segments: [
        { text: 'alpha beta', start: 0, end: 3 },
        { text: 'gamma delta epsilon', start: 4, end: 8 },
      ],
      cuts: [],
      source: 'ai' as const,
    }
    const s = scene({ refined })
    expect(sceneTail(s, 4)).toBe('beta gamma delta epsilon')
  })

  it('returns empty string for an empty scene', () => {
    const s = scene({ transcript: '   ', refined: null })
    expect(sceneTail(s)).toBe('')
  })
})

describe('segmentsToTimedWords', () => {
  it('flows words at the rate from each segment start, leaving gaps between', () => {
    const words = segmentsToTimedWords(
      [
        { text: 'a b', start: 0, end: 10 },
        { text: 'c d', start: 50, end: 60 },
      ],
      2, // 2 words/sec → 0.5s step
    )
    expect(words).toHaveLength(4)
    expect(words[0]).toMatchObject({ text: 'a', start: 0 })
    expect(words[1].start).toBeCloseTo(0.5, 5)
    // second segment starts at its own anchor, not continuing from the first
    expect(words[2]).toMatchObject({ text: 'c', start: 50 })
    expect(words[3].start).toBeCloseTo(50.5, 5)
  })

  it('fits a voiced segment to its real audio length', () => {
    // 4 words across a measured 8s clip → 2s per word, ending at the clip end.
    const words = segmentsToTimedWords([
      { text: 'one two three four', start: 10, end: 30, audioSeconds: 8 },
    ])
    expect(words).toHaveLength(4)
    expect(words[0]).toMatchObject({ text: 'one', start: 10 })
    expect(words[3].start).toBeCloseTo(16, 5) // 10 + 3*(8/4)
    expect(words[3].end).toBeCloseTo(18, 5) // ends at start + audioSeconds
  })

  it('returns [] for no segments', () => {
    expect(segmentsToTimedWords([])).toEqual([])
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

describe('gaps', () => {
  const sc = { start: 0, end: 100 }
  const seg = (start: number, end: number): NarrationSegment => ({ text: 'x', start, end })

  it('returns the empty spans around the segments', () => {
    expect(gaps([seg(10, 30), seg(60, 80)], sc)).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 60 },
      { start: 80, end: 100 },
    ])
  })

  it('is the whole scene when there are no segments', () => {
    expect(gaps([], sc)).toEqual([{ start: 0, end: 100 }])
  })

  it('ignores overlapping/touching segments when carving gaps', () => {
    expect(gaps([seg(0, 40), seg(20, 60)], sc)).toEqual([{ start: 60, end: 100 }])
  })
})

// Since story 03h fitsGap is a lands-clean HINT (tints the drop preview), not a
// gate — drops land anywhere in the scene, overlap allowed.
describe('fitsGap', () => {
  const sc = { start: 0, end: 100 }
  const seg = (start: number, end: number): NarrationSegment => ({ text: 'x', start, end })
  const segs = [seg(10, 30), seg(60, 80)] // gaps: 0–10, 30–60, 80–100

  it('is true for a clip that fits inside a single gap (lands clean)', () => {
    expect(fitsGap(segs, sc, 35, 20)).toBe(true) // 35–55 ⊂ 30–60
  })

  it('is false for a clip that overlaps a run (will flag an overlap)', () => {
    expect(fitsGap(segs, sc, 55, 20)).toBe(false) // 55–75 hits the 60–80 run
  })

  it('is false for a clip that spills past the scene', () => {
    expect(fitsGap(segs, sc, 90, 20)).toBe(false) // 90–110 > scene end
  })

  it('is false for a zero/negative duration', () => {
    expect(fitsGap(segs, sc, 35, 0)).toBe(false)
  })
})

describe('clampDropStart', () => {
  const sc = { start: 10, end: 100 }

  it('leaves a drop that already sits inside the scene alone', () => {
    expect(clampDropStart(sc, 30, 20)).toBe(30)
  })

  it('shifts the start left when the tail would pass the scene end', () => {
    expect(clampDropStart(sc, 95, 20)).toBe(80) // 80–100, pinned to the end
  })

  it('floors the start at the scene start', () => {
    expect(clampDropStart(sc, 0, 20)).toBe(10)
  })

  it('pins to the scene start when the clip is longer than the scene', () => {
    expect(clampDropStart(sc, 50, 200)).toBe(10)
  })
})

describe('moveRun', () => {
  const sc = { start: 0, end: 100 }
  const seg = (start: number, end: number): NarrationSegment => ({ text: `${start}`, start, end })

  it('moves the run keeping its duration and re-sorts ascending', () => {
    const moved = moveRun([seg(0, 10), seg(60, 80)], 1, 20, sc)
    expect(moved).toEqual([seg(0, 10), { text: '60', start: 20, end: 40 }])
    // sorted: moving the FIRST run past the second re-orders the list
    const reordered = moveRun([seg(0, 10), seg(60, 80)], 0, 85, sc)
    expect(reordered.map((s) => s.start)).toEqual([60, 85])
  })

  it('clamps so the run end never passes the scene end', () => {
    expect(moveRun([seg(0, 10)], 0, 95, sc)).toEqual([{ text: '0', start: 90, end: 100 }])
  })

  it('clamps the start at the scene start', () => {
    expect(moveRun([seg(40, 50)], 0, -20, { start: 5, end: 100 })).toEqual([
      { text: '40', start: 5, end: 15 },
    ])
  })

  it('keeps the run audio fields intact through a move', () => {
    const run: NarrationSegment = {
      text: 'voiced',
      start: 0,
      end: 10,
      audioUrl: '/api/uploads/voice/x.wav',
      audioSeconds: 10,
      audioSource: 'original',
    }
    expect(moveRun([run], 0, 30, sc)).toEqual([{ ...run, start: 30, end: 40 }])
  })

  it('is a no-op for an out-of-range index', () => {
    const segs = [seg(0, 10)]
    expect(moveRun(segs, 5, 30, sc)).toEqual(segs)
  })
})

describe('overlaps', () => {
  const seg = (start: number, end: number): NarrationSegment => ({ text: 'x', start, end })

  it('is empty when no runs overlap', () => {
    expect(overlaps([seg(0, 10), seg(30, 50)])).toEqual([])
  })

  it('returns the intersection of one overlapping pair', () => {
    expect(overlaps([seg(25, 35), seg(30, 40)])).toEqual([{ start: 30, end: 35 }])
  })

  it('returns multiple overlap spans, sorted', () => {
    expect(overlaps([seg(0, 12), seg(10, 20), seg(60, 80), seg(70, 75)])).toEqual([
      { start: 10, end: 12 },
      { start: 70, end: 75 },
    ])
  })

  it('does not flag exactly-touching runs', () => {
    expect(overlaps([seg(0, 10), seg(10, 20)])).toEqual([])
  })

  it('ignores sub-0.05s slivers', () => {
    expect(overlaps([seg(0, 10.02), seg(10, 20)])).toEqual([])
  })

  it('merges overlap spans that themselves overlap (three runs piled up)', () => {
    expect(overlaps([seg(0, 20), seg(5, 15), seg(10, 25)])).toEqual([{ start: 5, end: 20 }])
  })
})

describe('insertSegment / removeSegment', () => {
  const seg = (start: number, end: number): NarrationSegment => ({ text: `${start}`, start, end })

  it('inserts keeping ascending order', () => {
    expect(insertSegment([seg(0, 10), seg(60, 80)], seg(30, 50))).toEqual([
      seg(0, 10),
      seg(30, 50),
      seg(60, 80),
    ])
  })

  it('removes by index', () => {
    expect(removeSegment([seg(0, 10), seg(30, 50), seg(60, 80)], 1)).toEqual([
      seg(0, 10),
      seg(60, 80),
    ])
  })
})

describe('voicingSummary', () => {
  it('shows the director plan before refining', () => {
    expect(voicingSummary(scene({ voicing: 'original' }))).toBe('original audio')
    expect(voicingSummary(scene({ voicing: 'revoice' }))).toBe('re-voice')
    expect(voicingSummary(scene({ voicing: 'mixed' }))).toBe('partial')
    expect(voicingSummary(scene())).toBeNull()
  })

  it('derives the real mix from refined segments', () => {
    const refined = {
      segments: [
        { text: 'a', start: 0, end: 10, suggestedSource: 'original' as const },
        { text: 'b', start: 20, end: 30, suggestedSource: 'revoice' as const },
        { text: 'c', start: 40, end: 50 },
      ],
      cuts: [],
      source: 'ai' as const,
    }
    expect(voicingSummary(scene({ refined }))).toBe('1 original · 2 re-voice')
  })

  it('reads what actually happened over the suggestion', () => {
    const refined = {
      segments: [
        {
          text: 'a',
          start: 0,
          end: 10,
          suggestedSource: 'revoice' as const,
          audioUrl: '/x.wav',
          audioSeconds: 10,
          audioSource: 'original' as const,
        },
      ],
      cuts: [],
      source: 'ai' as const,
    }
    expect(voicingSummary(scene({ refined }))).toBe('original audio')
  })
})

describe('suggestedOriginalIndices', () => {
  it('lists unvoiced original-tagged segments only', () => {
    expect(
      suggestedOriginalIndices([
        { text: 'a', start: 0, end: 5, suggestedSource: 'original' },
        { text: 'b', start: 10, end: 15, suggestedSource: 'revoice' },
        { text: 'c', start: 20, end: 25, suggestedSource: 'original', audioUrl: '/x.wav' },
        { text: 'd', start: 30, end: 35 },
        { text: 'e', start: 40, end: 45, suggestedSource: 'original' },
      ]),
    ).toEqual([0, 4])
  })
})

describe('applyOriginalClips', () => {
  const segs: NarrationSegment[] = [
    { text: 'a', start: 0, end: 5, suggestedSource: 'original' },
    { text: 'b', start: 10, end: 15, suggestedSource: 'revoice' },
    { text: 'c', start: 20, end: 25, suggestedSource: 'original' },
  ]

  it('attaches clips, snapping each end to the measured length', () => {
    const { segments, failed } = applyOriginalClips(segs, [0, 2], [
      { url: '/api/uploads/voice/a.wav', seconds: 4.2 },
      { url: '/api/uploads/voice/c.wav', seconds: 5.5 },
    ])
    expect(failed).toBe(0)
    expect(segments[0]).toMatchObject({
      audioUrl: '/api/uploads/voice/a.wav',
      audioSeconds: 4.2,
      end: 4.2,
      audioSource: 'original',
      suggestedSource: 'original',
    })
    expect(segments[1]).toEqual(segs[1]) // untouched
    expect(segments[2]).toMatchObject({ audioSeconds: 5.5, end: 25.5 })
  })

  it('counts failed clips and leaves those segments unvoiced', () => {
    const { segments, failed } = applyOriginalClips(segs, [0, 2], [null, { url: '/c.wav', seconds: 5 }])
    expect(failed).toBe(1)
    expect(segments[0].audioUrl).toBeUndefined()
    expect(segments[2].audioUrl).toBe('/c.wav')
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
