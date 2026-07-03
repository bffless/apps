import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import type { TWord } from './transcriptGrid'
import {
  videoScript,
  videoChapters,
  chapterTime,
  formatChapters,
  scriptWords,
  sceneWordsLookup,
  buildDescribeRequest,
  toDescription,
  youtubeDescription,
} from './describe'

function scene(over: Partial<Scene> = {}): Scene {
  return {
    id: 's1',
    index: 0,
    sourceId: 'source-1',
    title: 'Scene 1',
    start: 0,
    end: 60,
    transcript: 'original transcript words',
    status: 'built',
    ...over,
  }
}

const refined = (cuts: { start: number; end: number }[]) => ({
  refined: { cuts, source: 'ai' as const },
})

/** Timed words spaced 1s apart from `start`, one per token. */
const timed = (text: string, start = 0): TWord[] =>
  text.split(/\s+/).map((t, i) => ({ text: t, start: start + i, end: start + i + 0.5 }))

/** A wordsFor over a per-scene-id map. */
const lookupBy = (map: Record<string, TWord[]>) => (s: Scene) => map[s.id] ?? []

describe('videoScript', () => {
  it('joins each scene’s kept words (its timed words minus the cuts), in order', () => {
    const scenes = [
      scene({ id: 'a', ...refined([{ start: 1, end: 2 }]) }), // drops "there"
      scene({ id: 'b' }),
    ]
    const wordsFor = lookupBy({
      a: timed('Hello there world'),
      b: timed('Second scene', 10),
    })
    expect(videoScript(scenes, wordsFor)).toBe('Hello world\n\nSecond scene')
  })

  it('skips a fully-cut scene', () => {
    const scenes = [
      scene({ id: 'a' }),
      scene({ id: 'b', ...refined([{ start: 0, end: 60 }]) }),
    ]
    const wordsFor = lookupBy({ a: timed('Kept.'), b: timed('All gone') })
    expect(videoScript(scenes, wordsFor)).toBe('Kept.')
  })

  it('falls back to the raw transcript when a scene has no timed words', () => {
    const scenes = [scene({ id: 'a', transcript: 'fallback words' })]
    expect(videoScript(scenes, () => [])).toBe('fallback words')
  })
})

describe('sceneWordsLookup', () => {
  it('slices the owning source’s words to the scene window', () => {
    const sources = [
      { id: 'source-1', words: timed('zero one two three four five') }, // starts at 0,1,2…
    ]
    const wordsFor = sceneWordsLookup(sources)
    const s = scene({ start: 2, end: 4 })
    expect(wordsFor(s).map((w) => w.text)).toEqual(['two', 'three'])
  })

  it('returns [] for an unknown source', () => {
    expect(sceneWordsLookup([])(scene())).toEqual([])
  })
})

describe('videoChapters', () => {
  it('starts the first chapter at 0 and accumulates final (post-cut) durations', () => {
    const scenes = [
      // 60s footage, 20s cut → 40s final
      scene({ id: 'a', title: 'Intro', start: 0, end: 60, ...refined([{ start: 0, end: 20 }]) }),
      // 30s footage, no cuts → 30s final
      scene({ id: 'b', title: 'Body', start: 60, end: 90 }),
    ]
    const chapters = videoChapters(scenes)
    expect(chapters).toEqual([
      { time: 0, title: 'Intro' },
      { time: 40, title: 'Body' },
    ])
  })

  it('single scene → one chapter at 0:00', () => {
    expect(videoChapters([scene({ title: 'Only' })])).toEqual([{ time: 0, title: 'Only' }])
  })
})

describe('chapterTime', () => {
  it('formats M:SS, padding seconds', () => {
    expect(chapterTime(0)).toBe('0:00')
    expect(chapterTime(8)).toBe('0:08')
    expect(chapterTime(83)).toBe('1:23')
  })
  it('clamps negatives to 0:00', () => {
    expect(chapterTime(-5)).toBe('0:00')
  })
})

describe('formatChapters', () => {
  it('renders YouTube-style lines', () => {
    expect(
      formatChapters([
        { time: 0, title: 'Intro' },
        { time: 83, title: 'Body' },
      ]),
    ).toBe('0:00 Intro\n1:23 Body')
  })
})

describe('scriptWords', () => {
  it('returns the kept words with their real timestamps', () => {
    const scenes = [scene({ id: 'a', ...refined([{ start: 1, end: 2 }]) })]
    const wordsFor = lookupBy({ a: timed('Hello there world') })
    expect(scriptWords(scenes, wordsFor)).toEqual([
      { text: 'Hello', start: 0, end: 0.5 },
      { text: 'world', start: 2, end: 2.5 },
    ])
  })

  it('concatenates across scenes', () => {
    const scenes = [scene({ id: 'a' }), scene({ id: 'b' })]
    const wordsFor = lookupBy({ a: timed('One'), b: timed('Two', 5) })
    expect(scriptWords(scenes, wordsFor).map((w) => w.text)).toEqual(['One', 'Two'])
  })
})

describe('buildDescribeRequest', () => {
  it('pairs the final script with the trimmed director synopsis', () => {
    const scenes = [scene({ id: 'a' })]
    const wordsFor = lookupBy({ a: timed('Kept line.') })
    expect(buildDescribeRequest(scenes, '  A talk about onboarding.  ', wordsFor)).toEqual({
      script: 'Kept line.',
      synopsis: 'A talk about onboarding.',
    })
  })
  it('tolerates a null synopsis', () => {
    expect(buildDescribeRequest([], null, () => [])).toEqual({ script: '', synopsis: '' })
  })
})

describe('toDescription', () => {
  it('coerces and trims a well-formed response', () => {
    expect(toDescription({ title: '  How Onboarding Works  ', summary: '  A summary.  ' })).toEqual({
      title: 'How Onboarding Works',
      summary: 'A summary.',
    })
  })
  it('returns empty strings for garbage', () => {
    expect(toDescription(null)).toEqual({ title: '', summary: '' })
    expect(toDescription({ title: 42 })).toEqual({ title: '', summary: '' })
    expect(toDescription('nope')).toEqual({ title: '', summary: '' })
  })
})

describe('youtubeDescription', () => {
  const chapters = [{ time: 0, title: 'Intro' }, { time: 83, title: 'Body' }]

  it('joins summary and chapter lines with a blank line between them', () => {
    expect(youtubeDescription('A great video.', chapters)).toBe(
      'A great video.\n\n0:00 Intro\n1:23 Body',
    )
  })

  it('drops to just chapter lines when summary is null or undefined', () => {
    expect(youtubeDescription(null, chapters)).toBe('0:00 Intro\n1:23 Body')
    expect(youtubeDescription(undefined, chapters)).toBe('0:00 Intro\n1:23 Body')
  })

  it('drops to just the summary when chapters array is empty', () => {
    expect(youtubeDescription('Just a summary.', [])).toBe('Just a summary.')
  })

  it('returns empty string when both summary and chapters are empty', () => {
    expect(youtubeDescription(null, [])).toBe('')
  })
})
