import { test, expect } from 'vitest'
import { uniqueSpeakers } from './speakers'
import type { TWord } from './transcriptGrid'

const words = (...labels: string[]): TWord[] =>
  labels.map((s, i) => ({ text: 'w', start: i, end: i + 0.5, speaker: s }))

test('uniqueSpeakers returns labels in first-seen order, ignoring undefined', () => {
  expect(uniqueSpeakers(words('SPEAKER_01', 'SPEAKER_00', 'SPEAKER_01'))).toEqual([
    'SPEAKER_01', 'SPEAKER_00',
  ])
  expect(uniqueSpeakers([{ text: 'x', start: 0, end: 1 }])).toEqual([])
})
