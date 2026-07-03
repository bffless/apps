import { describe, expect, it } from 'vitest'
import { auditionSpan, finalCutSeconds, nextKeptTime } from './playback'

describe('nextKeptTime', () => {
  const cuts = [{ start: 2, end: 4 }]

  it('returns t unchanged on kept footage', () => {
    expect(nextKeptTime(cuts, 1)).toBe(1)
    expect(nextKeptTime([], 7)).toBe(7)
  })

  it('lands on the cut end when t is inside a cut (start inclusive)', () => {
    expect(nextKeptTime(cuts, 2)).toBe(4)
    expect(nextKeptTime(cuts, 3.5)).toBe(4)
  })

  it('a cut end is already kept', () => {
    expect(nextKeptTime(cuts, 4)).toBe(4)
  })

  it('clears a chain of touching cuts in one hop', () => {
    expect(nextKeptTime([{ start: 2, end: 4 }, { start: 4, end: 6 }], 3)).toBe(6)
  })

  it('clears overlapping, out-of-order cuts', () => {
    expect(nextKeptTime([{ start: 5, end: 9 }, { start: 2, end: 6 }], 2.5)).toBe(9)
  })
})

describe('auditionSpan', () => {
  it('pads 1.5s of context on each side of the cut', () => {
    expect(auditionSpan({ start: 10, end: 12 }, 0, 60)).toEqual({ start: 8.5, end: 13.5 })
  })

  it('clamps to the scene window', () => {
    expect(auditionSpan({ start: 1, end: 59.5 }, 0.5, 60)).toEqual({ start: 0.5, end: 60 })
  })

  it('honours a custom pad', () => {
    expect(auditionSpan({ start: 10, end: 12 }, 0, 60, 3)).toEqual({ start: 7, end: 15 })
  })
})

describe('finalCutSeconds', () => {
  it('is the full source with no cuts', () => {
    expect(finalCutSeconds([], 730)).toBe(730)
  })

  it('subtracts the cut footage', () => {
    // 12:10 of source minus 7:38 of cuts = the story's `final cut 4:32`
    expect(finalCutSeconds([{ start: 10, end: 468 }], 730)).toBe(272)
  })

  it('counts overlapping cuts once', () => {
    expect(finalCutSeconds([{ start: 0, end: 6 }, { start: 4, end: 10 }], 20)).toBe(10)
  })

  it('clamps cuts to the footage and never goes negative', () => {
    expect(finalCutSeconds([{ start: -5, end: 8 }], 10)).toBe(2)
    expect(finalCutSeconds([{ start: 0, end: 99 }], 10)).toBe(0)
  })
})
