import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type ShapeOutput = {
  ok: boolean
  notOk: boolean
  video: {
    videoId: string
    title: string
    description: string | null
    youtubeId: string | null
    duration: number
    transcript: { words: unknown[] }
  } | null
}

const shapeFnSrc = loadFnSource('_custom/video-get/get/shape.fn.js')

function run(query: unknown): ShapeOutput {
  return runFn(shapeFnSrc, { steps: { query } }) as ShapeOutput
}

const WORDS = [
  { text: 'Hello', start: 0, end: 0.5 },
  { text: 'world.', start: 0.5, end: 1 },
]

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    title: 'Intro to Recall',
    description: 'A quick tour.',
    youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    status: 'published',
    duration: 125,
    transcript: JSON.stringify({ words: WORDS, text: 'Hello world.' }),
    ...overrides,
  }
}

describe('_custom/video-get/get/shape.fn.js', () => {
  test('returns ok:false when the record is missing (query is null)', () => {
    const out = run(null)
    expect(out).toEqual({ ok: false, notOk: true, video: null })
  })

  test('returns ok:false when the record is undefined (prep rejected, query never ran)', () => {
    const out = run(undefined)
    expect(out.ok).toBe(false)
    expect(out.notOk).toBe(true)
    expect(out.video).toBeNull()
  })

  test('returns ok:false when the record status is not published', () => {
    const out = run(record({ status: 'transcribed' }))
    expect(out.ok).toBe(false)
    expect(out.notOk).toBe(true)
    expect(out.video).toBeNull()
  })

  test('returns ok:false for draft/processing/error statuses too', () => {
    for (const status of ['draft', 'transcribing', 'indexing', 'error']) {
      const out = run(record({ status }))
      expect(out.ok).toBe(false)
    }
  })

  test('returns the full public shape for a published record', () => {
    const out = run(record())
    expect(out.ok).toBe(true)
    expect(out.notOk).toBe(false)
    expect(out.video).toEqual({
      videoId: 'v1',
      title: 'Intro to Recall',
      description: 'A quick tour.',
      youtubeId: 'dQw4w9WgXcQ',
      duration: 125,
      transcript: { words: WORDS },
    })
  })

  test('parses transcript JSON into { words } and drops the raw text field', () => {
    const out = run(record())
    expect(out.video?.transcript).toEqual({ words: WORDS })
    expect(out.video).not.toHaveProperty('text')
  })

  test('empty words array when transcript is missing', () => {
    const out = run(record({ transcript: null }))
    expect(out.video?.transcript).toEqual({ words: [] })
  })

  test('empty words array when transcript JSON fails to parse', () => {
    const out = run(record({ transcript: 'not json{' }))
    expect(out.video?.transcript).toEqual({ words: [] })
  })

  test('empty words array when parsed JSON has no words array', () => {
    const out = run(record({ transcript: JSON.stringify({ text: 'hi' }) }))
    expect(out.video?.transcript).toEqual({ words: [] })
  })

  test('extracts youtubeId from a bare 11-char id', () => {
    const out = run(record({ youtube_url: 'dQw4w9WgXcQ' }))
    expect(out.video?.youtubeId).toBe('dQw4w9WgXcQ')
  })

  test('youtubeId is null when youtube_url is missing/unparseable', () => {
    const out = run(record({ youtube_url: null }))
    expect(out.video?.youtubeId).toBeNull()
  })

  test('description defaults to null when not a string', () => {
    const out = run(record({ description: undefined }))
    expect(out.video?.description).toBeNull()
  })

  test('duration defaults to 0 when missing/invalid', () => {
    const out = run(record({ duration: undefined }))
    expect(out.video?.duration).toBe(0)
  })
})
