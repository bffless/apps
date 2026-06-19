import { describe, it, expect, test } from 'vitest'
import {
  timedTranscript,
  toScenes,
  combinedTimedTranscript,
  type DirectorScene,
  type TranscriptSource,
} from './director'

describe('timedTranscript', () => {
  it('groups words into wall-clock windows', () => {
    const words = [
      { text: 'hello', start: 0.2, end: 0.5 },
      { text: 'there', start: 1.0, end: 1.4 },
      { text: 'friend', start: 9.0, end: 9.5 }, // next 8s window
    ]
    const out = timedTranscript(words, 8)
    expect(out).toBe('[0:00] hello there\n[0:08] friend')
  })

  it('keeps null-timestamp words on the current line', () => {
    const words = [
      { text: 'a', start: 0.1, end: 0.3 },
      { text: 'b', start: null as unknown as number, end: null as unknown as number },
    ]
    expect(timedTranscript(words, 8)).toBe('[0:00] a b')
  })

  it('returns empty for no words', () => {
    expect(timedTranscript([], 8)).toBe('')
  })
})

describe('toScenes', () => {
  const raw: DirectorScene[] = [
    { title: 'Intro', start: 0, end: 60, transcript: 'Welcome to the talk', refinePrompt: 'Tighten the intro to a 15s hook.', cuts: [{ start: 10, end: 20 }] },
    { title: 'Demo', start: 60, end: 130, transcript: 'Here is the demo', refinePrompt: 'Cut the dead air; keep the screen-share.', cuts: [] },
  ]

  it('coerces to the Scene shape with ids, index, and defaults', () => {
    const scenes = toScenes(raw, [{ id: 'source-1', duration: 130 }])
    expect(scenes).toHaveLength(2)
    expect(scenes[0]).toMatchObject({
      id: 'scene-1',
      index: 0,
      title: 'Intro',
      start: 0,
      end: 60,
      status: 'pending',
      narrationSeconds: null,
      transcript: 'Welcome to the talk',
      refinePrompt: 'Tighten the intro to a 15s hook.',
    })
    expect(scenes[0].cuts).toEqual([{ start: 10, end: 20 }])
  })

  it('clamps spans into [0, duration] and forces them ascending + non-overlapping', () => {
    const messy: DirectorScene[] = [
      { start: -5, end: 40, transcript: 'one' },
      { start: 30, end: 200, transcript: 'two' }, // overlaps prev, runs past clip
    ]
    const scenes = toScenes(messy, [{ id: 'source-1', duration: 120 }])
    expect(scenes[0].start).toBe(0)
    expect(scenes[1].start).toBe(40) // snapped to prev end
    expect(scenes[1].end).toBe(120) // clamped to duration
  })

  it('drops cuts outside their scene span and clamps the rest', () => {
    const s: DirectorScene[] = [
      { start: 0, end: 100, transcript: 'x', cuts: [{ start: 50, end: 200 }, { start: 5, end: 5 }] },
    ]
    const [scene] = toScenes(s, [{ id: 'source-1', duration: 100 }])
    // 50–200 clamped to 50–100; the 5–5 zero-length cut dropped
    expect(scene.cuts).toEqual([{ start: 50, end: 100 }])
  })

  it('falls back to a title derived from the transcript', () => {
    const [scene] = toScenes([{ start: 0, end: 10, transcript: 'the quick brown fox jumps over' }], [{ id: 'source-1', duration: 10 }])
    expect(scene.title).toBe('the quick brown fox jumps…')
  })

  it('returns [] for non-array input', () => {
    expect(toScenes(undefined as unknown as DirectorScene[], [{ id: 'source-1', duration: 10 }])).toEqual([])
  })

  it('keeps a valid voicing plan and drops junk values (story 03j)', () => {
    const scenes = toScenes(
      [
        { start: 0, end: 30, transcript: 'a', voicing: 'original' },
        { start: 30, end: 60, transcript: 'b', voicing: 'mixed' },
        { start: 60, end: 90, transcript: 'c', voicing: 'shout it' as unknown as DirectorScene['voicing'] },
        { start: 90, end: 120, transcript: 'd' },
      ],
      [{ id: 'source-1', duration: 120 }],
    )
    expect(scenes.map((s) => s.voicing)).toEqual(['original', 'mixed', undefined, undefined])
  })
})

describe('toScenes — multi-source (09c)', () => {
  const SOURCES = [{ id: 'a', duration: 100 }, { id: 'b', duration: 100 }] // global [0,100),[100,200)

  it('maps a scene fully inside one source to local coords + sourceId', () => {
    const [s] = toScenes([{ start: 120, end: 160, title: 'X' }], SOURCES)
    expect(s).toMatchObject({ sourceId: 'b', start: 20, end: 60 })
  })

  it('assigns a boundary-crossing scene to the source it overlaps most (no split/duplication)', () => {
    // [80,140] overlaps a by 20 (80–100) and b by 40 (100–140) → dominant = b.
    const out = toScenes([{ start: 80, end: 140, title: 'Crosser' }], SOURCES)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ sourceId: 'b', start: 0, end: 40, title: 'Crosser' })
  })

  it('does NOT create a sliver duplicate when a rounded span overflows a source by a fraction (the multi-video dup bug)', () => {
    // Director returns a rounded 0–23 span; the real source is 22.8 s, so the old
    // split made a 0.2 s "Video One" sliver on the next source. Dominant-source
    // assignment keeps it as ONE scene on source a.
    const out = toScenes([{ start: 0, end: 23, title: 'Video One' }], [
      { id: 'a', duration: 22.8 },
      { id: 'b', duration: 13 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ sourceId: 'a', title: 'Video One' })
  })

  it('one director scene per video yields exactly one stored scene each (no fragments)', () => {
    const out = toScenes(
      [
        { start: 0, end: 23, title: 'One' },
        { start: 23, end: 36, title: 'Two' },
        { start: 36, end: 54, title: 'Three' },
        { start: 54, end: 66, title: 'Four' },
      ],
      [
        { id: 'a', duration: 23 },
        { id: 'b', duration: 13 },
        { id: 'c', duration: 18 },
        { id: 'd', duration: 12 },
      ],
    )
    expect(out.map((s) => s.title)).toEqual(['One', 'Two', 'Three', 'Four'])
    expect(out.map((s) => s.sourceId)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('clamps cuts into the (local) scene span', () => {
    const [s] = toScenes([{ start: 100, end: 160, title: 'X', cuts: [{ start: 110, end: 130 }] }], SOURCES)
    expect(s.sourceId).toBe('b')
    expect(s.cuts).toEqual([{ start: 10, end: 30 }])
  })

  it('single-source projects behave like before (local == global, one sourceId)', () => {
    const out = toScenes([{ start: 0, end: 50 }, { start: 50, end: 100 }], [{ id: 'a', duration: 100 }])
    expect(out.every((s) => s.sourceId === 'a')).toBe(true)
    expect(out[1]).toMatchObject({ start: 50, end: 100 })
  })
})

it('combinedTimedTranscript offsets each source to global time with boundary markers', () => {
  const out = combinedTimedTranscript([
    { id: 'a', fileName: 'one.mp4', duration: 16, words: [{ text: 'hello', start: 0, end: 1 }] },
    { id: 'b', fileName: 'two.mp4', duration: 16, words: [{ text: 'world', start: 0, end: 1 }] },
  ])
  expect(out).toMatch(/\[0:00\] hello/)
  expect(out).toMatch(/--- VIDEO 2: two\.mp4 \(starts 0:16\) ---/)
  expect(out).toMatch(/\[0:16\] world/)
})

test('combinedTimedTranscript labels speaker runs with resolved names', () => {
  const words = [
    { text: 'hello', start: 0, end: 0.5, speaker: 'SPEAKER_00' },
    { text: 'there', start: 0.6, end: 1.0, speaker: 'SPEAKER_00' },
    { text: 'hi', start: 1.2, end: 1.6, speaker: 'SPEAKER_01' },
  ]
  const src: TranscriptSource = { id: 'v1', fileName: 'a.mov', duration: 2, words }
  const out = combinedTimedTranscript([src], (videoId, label) =>
    videoId === 'v1' && label === 'SPEAKER_00' ? 'James' : 'Guest',
  )
  expect(out).toContain('James: hello there')
  expect(out).toContain('Guest: hi')
})

test('combinedTimedTranscript without a resolver is unchanged (no speaker labels)', () => {
  const src: TranscriptSource = {
    id: 'v1', fileName: 'a.mov', duration: 2,
    words: [{ text: 'hello', start: 0, end: 0.5, speaker: 'SPEAKER_00' }],
  }
  const out = combinedTimedTranscript([src])
  expect(out).not.toContain('SPEAKER_00')
  expect(out).toContain('hello')
})
