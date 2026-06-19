import { describe, it, expect } from 'vitest'
import type { Scene } from './scenes'
import {
  videoScript,
  videoChapters,
  chapterTime,
  formatChapters,
  scriptWords,
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
    narrationSeconds: null,
    ...over,
  }
}

const refined = (segments: { text: string; start: number; end: number }[], cuts: { start: number; end: number }[] = []) => ({
  refined: { segments, cuts, source: 'ai' as const },
})

describe('videoScript', () => {
  it('joins effective segment text across scenes in order', () => {
    const scenes = [
      scene({ id: 'a', ...refined([{ text: 'Hello there.', start: 0, end: 2 }]) }),
      scene({ id: 'b', ...refined([{ text: 'Second scene.', start: 0, end: 2 }, { text: 'More.', start: 2, end: 3 }]) }),
    ]
    expect(videoScript(scenes)).toBe('Hello there.\n\nSecond scene. More.')
  })

  it('skips scenes whose effective segments are empty', () => {
    const scenes = [
      scene({ id: 'a', ...refined([{ text: 'Kept.', start: 0, end: 2 }]) }),
      scene({ id: 'b', ...refined([]) }),
    ]
    expect(videoScript(scenes)).toBe('Kept.')
  })
})

describe('videoChapters', () => {
  it('starts the first chapter at 0 and accumulates final (post-cut) durations', () => {
    const scenes = [
      // 60s footage, 20s cut → 40s final
      scene({ id: 'a', title: 'Intro', start: 0, end: 60, ...refined([{ text: 'x', start: 0, end: 1 }], [{ start: 0, end: 20 }]) }),
      // 30s footage, no cuts → 30s final
      scene({ id: 'b', title: 'Body', start: 60, end: 90, ...refined([{ text: 'y', start: 60, end: 61 }]) }),
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
  it('spreads each segment’s words evenly across its span', () => {
    const scenes = [scene({ ...refined([{ text: 'Hello world', start: 0, end: 2 }]) })]
    expect(scriptWords(scenes)).toEqual([
      { text: 'Hello', start: 0, end: 1 },
      { text: 'world', start: 1, end: 2 },
    ])
  })

  it('concatenates across scenes and skips empty segments', () => {
    const scenes = [
      scene({ id: 'a', ...refined([{ text: 'One', start: 0, end: 1 }]) }),
      scene({ id: 'b', ...refined([{ text: '   ', start: 1, end: 2 }, { text: 'Two', start: 2, end: 3 }]) }),
    ]
    expect(scriptWords(scenes).map((w) => w.text)).toEqual(['One', 'Two'])
  })
})

describe('buildDescribeRequest', () => {
  it('pairs the final script with the trimmed director synopsis', () => {
    const scenes = [scene({ ...refined([{ text: 'Kept line.', start: 0, end: 2 }]) })]
    expect(buildDescribeRequest(scenes, '  A talk about onboarding.  ')).toEqual({
      script: 'Kept line.',
      synopsis: 'A talk about onboarding.',
    })
  })
  it('tolerates a null synopsis', () => {
    expect(buildDescribeRequest([], null)).toEqual({ script: '', synopsis: '' })
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
