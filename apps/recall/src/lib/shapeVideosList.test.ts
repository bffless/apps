import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type VideoMeta = {
  videoId: string
  title: string
  description: string | null
  youtubeId: string
  duration: number
  publishedAtMs: number
}
type ShapeOutput = { videos: VideoMeta[] }

const shapeFnSrc = loadFnSource('api/videos/get/shape.fn.js')

function run(rows: Record<string, unknown>[]): ShapeOutput {
  return runFn(shapeFnSrc, { steps: { query: rows } }) as ShapeOutput
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    title: 'Intro to Recall',
    description: 'A quick tour.',
    youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    status: 'published',
    duration: 125,
    source_path: 'videos/v1/source.mp4',
    audio_path: 'videos/v1/audio.wav',
    transcript: JSON.stringify({ words: [], text: '' }),
    created_ms: 1_700_000_000_000,
    updated_ms: 1_700_000_100_000,
    createdAt: '2023-11-14T00:00:00.000Z',
    ...overrides,
  }
}

describe('api/videos/get/shape.fn.js', () => {
  test('keeps only status === published rows', () => {
    const out = run([
      row({ id: 'v1', status: 'published' }),
      row({ id: 'v2', status: 'draft' }),
      row({ id: 'v3', status: 'transcribed' }),
      row({ id: 'v4', status: 'indexing' }),
      row({ id: 'v5', status: 'error' }),
    ])
    expect(out.videos.map((v) => v.videoId)).toEqual(['v1'])
  })

  test('drops transcript and both storage paths from the response', () => {
    const out = run([row()])
    expect(out.videos[0]).not.toHaveProperty('transcript')
    expect(out.videos[0]).not.toHaveProperty('source_path')
    expect(out.videos[0]).not.toHaveProperty('audio_path')
  })

  test('maps to the public meta shape', () => {
    const out = run([row()])
    expect(out.videos[0]).toEqual({
      videoId: 'v1',
      title: 'Intro to Recall',
      description: 'A quick tour.',
      youtubeId: 'dQw4w9WgXcQ',
      duration: 125,
      publishedAtMs: 1_700_000_100_000,
    })
  })

  test('publishedAtMs falls back to createdAt when updated_ms is missing/zero', () => {
    const out = run([row({ updated_ms: 0, createdAt: '2023-11-14T00:00:00.000Z' })])
    expect(out.videos[0].publishedAtMs).toBe(new Date('2023-11-14T00:00:00.000Z').getTime())
  })

  test('publishedAtMs is 0 when both updated_ms and createdAt are missing', () => {
    const out = run([row({ updated_ms: undefined, createdAt: undefined })])
    expect(out.videos[0].publishedAtMs).toBe(0)
  })

  test('sorts newest-first by publishedAtMs', () => {
    const out = run([
      row({ id: 'old', updated_ms: 1_000 }),
      row({ id: 'new', updated_ms: 3_000 }),
      row({ id: 'mid', updated_ms: 2_000 }),
    ])
    expect(out.videos.map((v) => v.videoId)).toEqual(['new', 'mid', 'old'])
  })

  test('skips a published row with no extractable youtube id', () => {
    const out = run([row({ youtube_url: 'https://vimeo.com/12345' })])
    expect(out.videos).toHaveLength(0)
  })

  test('an empty row list returns an empty videos array', () => {
    expect(run([])).toEqual({ videos: [] })
  })
})
