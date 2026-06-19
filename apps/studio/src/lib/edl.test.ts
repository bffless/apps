import { describe, it, expect } from 'vitest'
import {
  normalizeCuts,
  removedDuration,
  editedDuration,
  cutAt,
  keptSegments,
  formatTime,
  type Cut,
} from './edl'

const cut = (id: string, start: number, end: number): Cut => ({ id, start, end })

describe('normalizeCuts', () => {
  it('sorts by start time', () => {
    const result = normalizeCuts([cut('b', 10, 12), cut('a', 2, 4)])
    expect(result.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('merges overlapping and touching cuts', () => {
    const result = normalizeCuts([cut('a', 2, 5), cut('b', 4, 8), cut('c', 8, 9)])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ start: 2, end: 9 })
  })

  it('drops zero-length and inverted cuts', () => {
    expect(normalizeCuts([cut('a', 5, 5), cut('b', 9, 3)])).toEqual([])
  })
})

describe('removedDuration / editedDuration', () => {
  it('sums non-overlapping cuts', () => {
    expect(removedDuration([cut('a', 0, 2), cut('b', 5, 6)])).toBe(3)
  })

  it('counts overlapping cuts only once', () => {
    expect(removedDuration([cut('a', 0, 5), cut('b', 3, 8)])).toBe(8)
  })

  it('subtracts removed time from the original duration, never below zero', () => {
    expect(editedDuration([cut('a', 0, 4)], 10)).toBe(6)
    expect(editedDuration([cut('a', 0, 100)], 10)).toBe(0)
  })
})

describe('cutAt', () => {
  const cuts = [cut('a', 2, 4), cut('b', 6, 8)]

  it('returns the cut containing the time', () => {
    expect(cutAt(cuts, 3)?.id).toBe('a')
  })

  it('is inclusive of start, exclusive of end', () => {
    expect(cutAt(cuts, 2)?.id).toBe('a')
    expect(cutAt(cuts, 4)).toBeNull()
  })

  it('returns null outside any cut', () => {
    expect(cutAt(cuts, 5)).toBeNull()
  })
})

describe('keptSegments', () => {
  it('returns the whole clip when there are no cuts', () => {
    expect(keptSegments([], 10)).toEqual([{ start: 0, end: 10 }])
  })

  it('returns the complement of the cuts', () => {
    expect(keptSegments([cut('a', 2, 4), cut('b', 6, 8)], 10)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
      { start: 8, end: 10 },
    ])
  })

  it('handles a cut at the very start', () => {
    expect(keptSegments([cut('a', 0, 3)], 10)).toEqual([{ start: 3, end: 10 }])
  })

  it('handles a cut running to the end', () => {
    expect(keptSegments([cut('a', 7, 10)], 10)).toEqual([{ start: 0, end: 7 }])
  })
})

describe('formatTime', () => {
  it('formats minutes, seconds, and tenths', () => {
    expect(formatTime(0)).toBe('0:00.0')
    expect(formatTime(5.4)).toBe('0:05.4')
    expect(formatTime(72.9)).toBe('1:12.9')
  })

  it('clamps negative and non-finite input to zero', () => {
    expect(formatTime(-3)).toBe('0:00.0')
    expect(formatTime(NaN)).toBe('0:00.0')
  })
})
