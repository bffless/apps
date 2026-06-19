import { test, expect } from 'vitest'
import { paragraphs } from './transcriptText'
import type { TranscriptWord } from '../store/studioSlice'

const w = (text: string, start: number, speaker?: string): TranscriptWord => ({
  text,
  start,
  end: start + 0.3,
  ...(speaker ? { speaker } : {}),
})

test('paragraphs breaks on a speaker change within the same time bucket', () => {
  const rows = paragraphs(
    [w('hi', 0, 'SPEAKER_00'), w('there', 0.5, 'SPEAKER_00'), w('hello', 1, 'SPEAKER_01')],
    15,
  )
  expect(rows).toEqual([
    { start: 0, speaker: 'SPEAKER_00', text: 'hi there' },
    { start: 1, speaker: 'SPEAKER_01', text: 'hello' },
  ])
})

test('paragraphs breaks on the time bucket rolling over for the same speaker', () => {
  const rows = paragraphs([w('a', 0, 'SPEAKER_00'), w('b', 16, 'SPEAKER_00')], 15)
  expect(rows.map((r) => r.start)).toEqual([0, 16])
})

test('paragraphs keeps a single speaker run together and carries no speaker when absent', () => {
  const rows = paragraphs([w('one', 0), w('two', 0.4)], 15)
  expect(rows).toEqual([{ start: 0, speaker: undefined, text: 'one two' }])
})
