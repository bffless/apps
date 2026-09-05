import { describe, it, expect } from 'vitest'
import { transcribeWordCount, videoJobStats, formatVideoJobLine } from '../jobs'

describe('transcribeWordCount', () => {
  it('returns the word count of a finished transcribe job', () => {
    expect(
      transcribeWordCount({ kind: 'transcribe', status: 'done', result: { words: [{ text: 'hi' }, { text: 'there' }] } }),
    ).toBe(2)
  })

  it('returns 0 for a finished transcribe job with no words (silent audio)', () => {
    expect(transcribeWordCount({ kind: 'transcribe', status: 'done', result: { text: '', words: [] } })).toBe(0)
    expect(transcribeWordCount({ kind: 'transcribe', status: 'done', result: {} })).toBe(0)
    expect(transcribeWordCount({ kind: 'transcribe', status: 'done', result: null })).toBe(0)
  })

  it('returns null for anything that is not a finished transcribe job', () => {
    expect(transcribeWordCount({ kind: 'transcribe', status: 'running', result: null })).toBeNull()
    expect(transcribeWordCount({ kind: 'scenes', status: 'done', result: {} })).toBeNull()
    expect(transcribeWordCount({ kind: 'video-extract', status: 'done', result: {} })).toBeNull()
    expect(transcribeWordCount(null)).toBeNull()
    expect(transcribeWordCount('nope')).toBeNull()
    expect(transcribeWordCount({ status: 'done' })).toBeNull()
  })
})

describe('videoJobStats', () => {
  it('returns kind, executor and totalMs of a finished video job (CE >= 0.4.31 result)', () => {
    const result = {
      url: '/api/uploads/projects/p1/scene-clip/server/c.mp4',
      audioUrl: null,
      duration: 4.2,
      executor: 'remote',
      timings: { queueMs: 120, transferInMs: 3400, ffmpegMs: 15010, transferOutMs: 2300, totalMs: 20830 },
      bytesIn: 104857600,
      bytesOut: 2097152,
    }
    expect(videoJobStats({ kind: 'video-slice', status: 'done', result })).toEqual({
      kind: 'video-slice',
      executor: 'remote',
      totalMs: 20830,
    })
    expect(videoJobStats({ kind: 'video-extract', status: 'done', result: { url: '/x', executor: 'local', timings: { totalMs: 1200 } } }))
      .toEqual({ kind: 'video-extract', executor: 'local', totalMs: 1200 })
    expect(videoJobStats({ kind: 'video-concat', status: 'done', result: { url: '/x', executor: 'local', timings: { totalMs: 3600 } } }))
      .toEqual({ kind: 'video-concat', executor: 'local', totalMs: 3600 })
  })

  it('nulls executor/totalMs when the row lacks them (pre-0.4.31 CE)', () => {
    expect(videoJobStats({ kind: 'video-slice', status: 'done', result: { url: '/x', audioUrl: null, duration: 4.2 } }))
      .toEqual({ kind: 'video-slice', executor: null, totalMs: null })
    expect(videoJobStats({ kind: 'video-concat', status: 'done', result: { url: '/x', timings: {} } }))
      .toEqual({ kind: 'video-concat', executor: null, totalMs: null })
    expect(videoJobStats({ kind: 'video-extract', status: 'done', result: null }))
      .toEqual({ kind: 'video-extract', executor: null, totalMs: null })
  })

  it('returns null for anything that is not a finished video job', () => {
    expect(videoJobStats({ kind: 'video-slice', status: 'running', result: null })).toBeNull()
    expect(videoJobStats({ kind: 'video-slice', status: 'error', error: 'Server slice failed' })).toBeNull()
    expect(videoJobStats({ kind: 'transcribe', status: 'done', result: { words: [] } })).toBeNull()
    expect(videoJobStats({ kind: 'scenes', status: 'done', result: {} })).toBeNull()
    expect(videoJobStats(null)).toBeNull()
    expect(videoJobStats('nope')).toBeNull()
    expect(videoJobStats({ status: 'done' })).toBeNull()
  })
})

describe('formatVideoJobLine', () => {
  it('renders `kind · executor · seconds` with one decimal', () => {
    expect(formatVideoJobLine({ kind: 'video-slice', executor: 'remote', totalMs: 20830 })).toBe('video-slice · remote · 20.8 s')
  })
  it('renders — for a missing field', () => {
    expect(formatVideoJobLine({ kind: 'video-concat', executor: null, totalMs: null })).toBe('video-concat · — · —')
    expect(formatVideoJobLine({ kind: 'video-extract', executor: 'local', totalMs: null })).toBe('video-extract · local · —')
  })
})
