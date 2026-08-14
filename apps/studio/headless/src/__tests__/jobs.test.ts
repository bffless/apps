import { describe, it, expect } from 'vitest'
import { transcribeWordCount } from '../jobs'

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
