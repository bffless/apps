import { describe, expect, it } from 'vitest'
import { toVideoResult } from './studioApi'

/** Mock and real /api/video job results must coerce through one pure toX() (CLAUDE.md). */
describe('toVideoResult', () => {
  it('passes through a full slice result', () => {
    expect(
      toVideoResult({ url: '/api/uploads/projects/p1/scene-clip/server/a.mp4', audioUrl: '/api/uploads/x.wav', duration: 12.5 }),
    ).toEqual({ url: '/api/uploads/projects/p1/scene-clip/server/a.mp4', audioUrl: '/api/uploads/x.wav', duration: 12.5 })
  })

  it('normalizes missing optionals to null', () => {
    expect(toVideoResult({ url: '/api/uploads/y.mp4' })).toEqual({ url: '/api/uploads/y.mp4', audioUrl: null, duration: null })
  })

  it('throws on a missing or non-string url (a job that "succeeded" without output is a failure)', () => {
    expect(() => toVideoResult({})).toThrow()
    expect(() => toVideoResult(null)).toThrow()
    expect(() => toVideoResult({ url: 42 })).toThrow()
  })

  it('tolerates a JSON-string result blob (data_query may return the row json as a string)', () => {
    expect(toVideoResult(JSON.stringify({ url: '/api/uploads/z.mp4' }))).toEqual({ url: '/api/uploads/z.mp4', audioUrl: null, duration: null })
  })
})
