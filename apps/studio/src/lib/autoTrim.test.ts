import { describe, expect, it } from 'vitest'
import { autoTrimCuts, planAutoTrim, DEFAULT_AUTO_TRIM_KNOBS } from './autoTrim'

const knobs = { minPauseSeconds: 0.6, keepPaddingSeconds: 0.2 }
const window = { start: 0, end: 60 }

describe('autoTrimCuts', () => {
  it('turns a qualifying pause into a cut inset by the keep-padding', () => {
    expect(autoTrimCuts([{ start: 10, end: 12 }], window, knobs)).toEqual([
      { start: 10.2, end: 11.8 },
    ])
  })

  it('drops pauses shorter than the minimum — natural speech rhythm', () => {
    expect(autoTrimCuts([{ start: 10, end: 10.5 }], window, knobs)).toEqual([])
  })

  it('keeps a pause of exactly the minimum, despite lattice float drift', () => {
    // 0.6 on the ms-rounded span lattice can sit a hair under 0.6 in floats
    expect(autoTrimCuts([{ start: 10.3, end: 10.9 }], window, knobs)).toEqual([
      { start: 10.5, end: 10.7 },
    ])
  })

  it('drops a cut the padding collapses to a sliver', () => {
    // 0.65s pause − 2 × 0.3 padding = 0.05 — a sliver, not an edit
    expect(
      autoTrimCuts([{ start: 10, end: 10.65 }], window, { minPauseSeconds: 0.6, keepPaddingSeconds: 0.3 }),
    ).toEqual([])
  })

  it('zero padding cuts the whole pause', () => {
    expect(
      autoTrimCuts([{ start: 10, end: 12 }], window, { minPauseSeconds: 0.6, keepPaddingSeconds: 0 }),
    ).toEqual([{ start: 10, end: 12 }])
  })

  it('clamps to the scene window and measures the clamped pause', () => {
    // the in-scene share (11→12) still qualifies…
    expect(autoTrimCuts([{ start: 10, end: 12 }], { start: 11, end: 60 }, knobs)).toEqual([
      { start: 11.2, end: 11.8 },
    ])
    // …but a 0.4s share does not, even though the whole pause is 2s
    expect(autoTrimCuts([{ start: 10, end: 12 }], { start: 11.6, end: 60 }, knobs)).toEqual([])
  })

  it('ignores spans wholly outside the window', () => {
    expect(autoTrimCuts([{ start: 70, end: 75 }], window, knobs)).toEqual([])
  })

  it('trims every qualifying pause, in order', () => {
    const spans = [
      { start: 5, end: 6 },
      { start: 8, end: 8.4 }, // too short
      { start: 20, end: 23 },
    ]
    expect(autoTrimCuts(spans, window, knobs)).toEqual([
      { start: 5.2, end: 5.8 },
      { start: 20.2, end: 22.8 },
    ])
  })
})

describe('planAutoTrim', () => {
  it('plans the cuts and the seconds they remove', () => {
    const plan = planAutoTrim([{ start: 10, end: 12 }, { start: 20, end: 21 }], [], window, knobs)
    expect(plan.cuts).toEqual([
      { start: 10.2, end: 11.8 },
      { start: 20.2, end: 20.8 },
    ])
    expect(plan.removedSeconds).toBeCloseTo(2.2)
  })

  it('skips pauses already cut — a second run changes nothing', () => {
    const spans = [{ start: 10, end: 12 }]
    const first = planAutoTrim(spans, [], window, knobs)
    const second = planAutoTrim(spans, first.cuts, window, knobs)
    expect(second).toEqual({ cuts: [], removedSeconds: 0 })
  })

  it('counts only the newly removed seconds where a trim overlaps an existing cut', () => {
    // hand cut already covers 10→11; the trim's 10.2→11.8 only adds 11→11.8
    const plan = planAutoTrim([{ start: 10, end: 12 }], [{ start: 10, end: 11 }], window, knobs)
    expect(plan.cuts).toEqual([{ start: 10.2, end: 11.8 }])
    expect(plan.removedSeconds).toBeCloseTo(0.8)
  })

  it('returns an empty plan when there is no dead space', () => {
    expect(planAutoTrim([], [], window, knobs)).toEqual({ cuts: [], removedSeconds: 0 })
  })

  it('default knobs trim with 0.6s minimum pause and 0.2s padding', () => {
    expect(DEFAULT_AUTO_TRIM_KNOBS.minPauseSeconds).toBe(0.6)
    expect(DEFAULT_AUTO_TRIM_KNOBS.keepPaddingSeconds).toBe(0.2)
    const plan = planAutoTrim([{ start: 1, end: 2 }], [], { start: 0, end: 6 }, DEFAULT_AUTO_TRIM_KNOBS)
    expect(plan.cuts).toEqual([{ start: 1.2, end: 1.8 }])
  })
})
