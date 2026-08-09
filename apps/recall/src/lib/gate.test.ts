import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type GateOutput = { ok: boolean; notOk: boolean; reason: string }

const gateFnSrc = loadFnSource('api/index/post/gate.fn.js')

function run(record: Record<string, unknown> | null): GateOutput {
  return runFn(gateFnSrc, { steps: { load: record } }) as GateOutput
}

const validRecord = {
  status: 'transcribed',
  youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  transcript: '{"words":[]}',
}

describe('gate.fn.js', () => {
  test('rejects when the video record is missing', () => {
    const out = run(null)
    expect(out).toEqual({ ok: false, notOk: true, reason: 'VIDEO_NOT_FOUND' })
  })

  test('rejects a video whose status is neither transcribed nor published', () => {
    const out = run({ ...validRecord, status: 'draft' })
    expect(out).toEqual({ ok: false, notOk: true, reason: 'INVALID_STATUS' })
  })

  test('rejects a video with no (or an invalid) youtube_url', () => {
    const out = run({ ...validRecord, youtube_url: '' })
    expect(out).toEqual({ ok: false, notOk: true, reason: 'MISSING_YOUTUBE_URL' })

    const outInvalid = run({ ...validRecord, youtube_url: 'not a youtube url' })
    expect(outInvalid).toEqual({ ok: false, notOk: true, reason: 'MISSING_YOUTUBE_URL' })
  })

  test('rejects a video with no transcript', () => {
    const out = run({ ...validRecord, transcript: null })
    expect(out).toEqual({ ok: false, notOk: true, reason: 'MISSING_TRANSCRIPT' })
  })

  test('passes an eligible video (transcribed, valid youtube_url, has a transcript)', () => {
    const out = run(validRecord)
    expect(out).toEqual({ ok: true, notOk: false, reason: '' })
  })

  test('a re-publish (status already published) is eligible too', () => {
    const out = run({ ...validRecord, status: 'published' })
    expect(out.ok).toBe(true)
  })
})
