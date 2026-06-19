import { test, expect } from 'vitest'
import {
  uniqueSpeakers, resolvePerson, resolveSpeakerVoice, seedAssignmentsByLabel, dominantSpeaker,
  speakerSampleSpans,
} from './speakers'
import type { Person } from '../store/studioSlice'
import type { TWord } from './transcriptGrid'

const words = (...labels: string[]): TWord[] =>
  labels.map((s, i) => ({ text: 'w', start: i, end: i + 0.5, speaker: s }))

test('uniqueSpeakers returns labels in first-seen order, ignoring undefined', () => {
  expect(uniqueSpeakers(words('SPEAKER_01', 'SPEAKER_00', 'SPEAKER_01'))).toEqual([
    'SPEAKER_01', 'SPEAKER_00',
  ])
  expect(uniqueSpeakers([{ text: 'x', start: 0, end: 1 }])).toEqual([])
})

test('resolvePerson: explicit assignment wins; single-person cast is the fallback', () => {
  const cast: Person[] = [{ id: 'p1', name: 'Me', voice: null }]
  expect(resolvePerson('v1', 'SPEAKER_00', cast, {})?.id).toBe('p1')
  const two: Person[] = [...cast, { id: 'p2', name: 'Guest', voice: null }]
  expect(resolvePerson('v1', 'SPEAKER_00', two, {})).toBeNull()
  const asg = { v1: { SPEAKER_00: 'p2' } }
  expect(resolvePerson('v1', 'SPEAKER_00', two, asg)?.id).toBe('p2')
})

test('resolveSpeakerVoice returns the resolved person voice or null', () => {
  const voice = { voiceId: 'v', source: 'preset' as const, label: 'x' }
  const cast: Person[] = [{ id: 'p1', name: 'Me', voice }]
  expect(resolveSpeakerVoice('v1', 'SPEAKER_00', cast, {})).toEqual(voice)
})

test('seedAssignmentsByLabel maps the Nth label to the Nth person', () => {
  const cast: Person[] = [
    { id: 'p1', name: 'Me', voice: null },
    { id: 'p2', name: 'Guest', voice: null },
  ]
  const seeded = seedAssignmentsByLabel('v1', ['SPEAKER_00', 'SPEAKER_01'], cast, {})
  expect(seeded).toEqual({ SPEAKER_00: 'p1', SPEAKER_01: 'p2' })
})

test('seedAssignmentsByLabel preserves existing entries and does not mutate input', () => {
  const cast: Person[] = [
    { id: 'p1', name: 'Me', voice: null },
    { id: 'p2', name: 'Guest', voice: null },
  ]
  const input = { v1: { SPEAKER_00: 'p2' } }
  const seeded = seedAssignmentsByLabel('v1', ['SPEAKER_00', 'SPEAKER_01'], cast, input)
  expect(seeded).toEqual({ SPEAKER_00: 'p2', SPEAKER_01: 'p2' })
  expect(input).toEqual({ v1: { SPEAKER_00: 'p2' } })
})

test('dominantSpeaker picks the label covering the most of the window', () => {
  const ws = [
    { text: 'a', start: 0, end: 2, speaker: 'SPEAKER_00' },
    { text: 'b', start: 2, end: 2.4, speaker: 'SPEAKER_01' },
  ]
  expect(dominantSpeaker(ws, 0, 3)).toBe('SPEAKER_00')
  expect(dominantSpeaker(ws, 1.9, 2.5)).toBe('SPEAKER_01')
  expect(dominantSpeaker(ws, 10, 12)).toBeNull()
})

test('speakerSampleSpans returns chronological, length-capped runs for a speaker', () => {
  const ws: TWord[] = [
    { text: 'a', start: 0, end: 1, speaker: 'S0' },
    { text: 'b', start: 1, end: 2, speaker: 'S0' }, // run S0 [0,2]
    { text: 'c', start: 2, end: 3, speaker: 'S1' }, // breaks the run
    { text: 'd', start: 5, end: 9, speaker: 'S0' }, // run S0 [5,9]
  ]
  expect(speakerSampleSpans(ws, 'S0', { maxSamples: 2, maxSeconds: 6, minSeconds: 1 })).toEqual([
    { start: 0, end: 2 },
    { start: 5, end: 9 },
  ])
})

test('speakerSampleSpans caps a long run to maxSeconds', () => {
  const ws: TWord[] = [{ text: 'x', start: 10, end: 30, speaker: 'S0' }]
  expect(speakerSampleSpans(ws, 'S0', { maxSeconds: 6 })).toEqual([{ start: 10, end: 16 }])
})

test('speakerSampleSpans is empty for a speaker that never speaks', () => {
  const ws: TWord[] = [{ text: 'x', start: 0, end: 1, speaker: 'S0' }]
  expect(speakerSampleSpans(ws, 'S9')).toEqual([])
})

test('speakerSampleSpans picks the two longest runs but returns them in time order', () => {
  const ws: TWord[] = [
    { text: 'a', start: 0, end: 0.5, speaker: 'S0' }, // short [0,0.5]
    { text: 'b', start: 1, end: 1.5, speaker: 'S1' },
    { text: 'c', start: 2, end: 5, speaker: 'S0' }, // long [2,5]
    { text: 'd', start: 6, end: 6.4, speaker: 'S1' },
    { text: 'e', start: 7, end: 10, speaker: 'S0' }, // long [7,10]
  ]
  expect(speakerSampleSpans(ws, 'S0', { maxSamples: 2, minSeconds: 1 })).toEqual([
    { start: 2, end: 5 },
    { start: 7, end: 10 },
  ])
})
