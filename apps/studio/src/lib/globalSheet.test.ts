import { describe, it, expect } from 'vitest'
import { planGlobalSheetCaptures, allocateSheets } from './globalSheet'

describe('planGlobalSheetCaptures', () => {
  it('spaces frames across the combined timeline and routes each to its source + local time', () => {
    const sources = [{ id: 'a', duration: 100 }, { id: 'b', duration: 100 }]
    const caps = planGlobalSheetCaptures(sources)
    expect(caps.length).toBeGreaterThan(0)
    expect(caps.every((c) => c.sourceId === 'a' || c.sourceId === 'b')).toBe(true)
    expect(caps.every((c) => c.localTime >= 0 && c.localTime <= 100)).toBe(true)
    const globals = caps.map((c) => c.globalTime)
    expect([...globals]).toEqual([...globals].sort((x, y) => x - y))
  })

  it('stays within the per-call image budget for very long totals', () => {
    const sources = Array.from({ length: 20 }, (_, i) => ({ id: `v${i}`, duration: 600 }))
    const caps = planGlobalSheetCaptures(sources)
    expect(caps.length).toBeLessThanOrEqual(120) // MAX_FRAMES; composed into ≤10 sheets
  })

  it('fills the budget densely for short totals (1s floor, not the 5s clip-wide floor)', () => {
    // A short multi-video project should sample at ~1s, using lots of the budget —
    // NOT the sparse 5s clip-wide default that left only ~2 of 10 sheets used.
    const caps = planGlobalSheetCaptures([{ id: 'a', duration: 30 }, { id: 'b', duration: 36 }]) // 66s
    expect(caps.length).toBe(66) // 1s apart across the 66s total, well under the 120 cap
  })
})

describe('planGlobalSheetCaptures sheet budget', () => {
  it('is unchanged when no budget is passed', () => {
    const sources = [{ id: 'a', duration: 1800 }, { id: 'b', duration: 1800 }]
    expect(planGlobalSheetCaptures(sources)).toHaveLength(120)
  })

  // Per-recording allocation: MAX_SHEETS (10) whole sheets are split across
  // recordings by length, so Σ ceil(nᵢ/12) ≤ 10 no matter how many recordings.
  const perSourceCounts = (caps: ReturnType<typeof planGlobalSheetCaptures>, ids: string[]) =>
    ids.map((id) => caps.filter((c) => c.sourceId === id).length)

  it('1 recording of 3600s gets the full 120-frame budget', () => {
    const caps = planGlobalSheetCaptures([{ id: 'a', duration: 3600 }], 12)
    expect(perSourceCounts(caps, ['a'])).toEqual([120])
    expect(caps).toHaveLength(120)
  })

  it('2 recordings of 1800s split 60/60', () => {
    const sources = [{ id: 'a', duration: 1800 }, { id: 'b', duration: 1800 }]
    const caps = planGlobalSheetCaptures(sources, 12)
    const counts = perSourceCounts(caps, ['a', 'b'])
    expect(counts).toEqual([60, 60])
    expect(counts.reduce((n, c) => n + c, 0)).toBe(120)
    const sheets = counts.reduce((n, c) => n + Math.ceil(c / 12), 0)
    expect(sheets).toBeLessThanOrEqual(10)
  })

  it('3 recordings of 1800s split 40/36/36 (sheets 4/3/3)', () => {
    const sources = [{ id: 'a', duration: 1800 }, { id: 'b', duration: 1800 }, { id: 'c', duration: 1800 }]
    const caps = planGlobalSheetCaptures(sources, 12)
    const counts = perSourceCounts(caps, ['a', 'b', 'c'])
    expect(counts).toEqual([40, 36, 36])
    expect(counts.reduce((n, c) => n + c, 0)).toBe(112)
    const sheets = counts.map((c) => Math.ceil(c / 12))
    expect(sheets).toEqual([4, 3, 3])
    expect(sheets.reduce((n, c) => n + c, 0)).toBeLessThanOrEqual(10)
  })

  it('5 recordings of 1800s split evenly, 24 each', () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, duration: 1800 }))
    const caps = planGlobalSheetCaptures(sources, 12)
    const counts = perSourceCounts(caps, sources.map((s) => s.id))
    expect(counts).toEqual([24, 24, 24, 24, 24])
    expect(counts.reduce((n, c) => n + c, 0)).toBe(120)
    const sheets = counts.reduce((n, c) => n + Math.ceil(c / 12), 0)
    expect(sheets).toBeLessThanOrEqual(10)
  })

  it('30s + 36s recordings split 30/36', () => {
    const sources = [{ id: 'a', duration: 30 }, { id: 'b', duration: 36 }]
    const caps = planGlobalSheetCaptures(sources, 12)
    const counts = perSourceCounts(caps, ['a', 'b'])
    expect(counts).toEqual([30, 36])
    expect(counts.reduce((n, c) => n + c, 0)).toBe(66)
    const sheets = counts.reduce((n, c) => n + Math.ceil(c / 12), 0)
    expect(sheets).toBeLessThanOrEqual(10)
  })

  it('11 equal recordings: the first 10 get 11 frames each, the 11th gets none', () => {
    const sources = Array.from({ length: 11 }, (_, i) => ({ id: `s${i}`, duration: 600 }))
    const caps = planGlobalSheetCaptures(sources, 12)
    const counts = perSourceCounts(caps, sources.map((s) => s.id))
    expect(counts).toEqual([11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 0])
    expect(counts.reduce((n, c) => n + c, 0)).toBe(110)
    const sheets = counts.reduce((n, c) => n + Math.ceil(c / 12), 0)
    expect(sheets).toBeLessThanOrEqual(10)
  })

  it('keeps Σ ceil(nᵢ/12) ≤ 10 for varied durations and 1..15 recordings, with every recording covered up to 10, and no recording beyond 10', () => {
    for (let k = 1; k <= 15; k++) {
      const durations = Array.from({ length: k }, (_, i) => 60 + ((i * 137) % 1800))
      const sources = durations.map((d, i) => ({ id: `s${i}`, duration: d }))
      const caps = planGlobalSheetCaptures(sources, 12)
      const counts = perSourceCounts(caps, sources.map((s) => s.id))
      const sheets = counts.reduce((n, c) => n + Math.ceil(c / 12), 0)
      expect(sheets).toBeLessThanOrEqual(10)
      const withCaptures = counts.filter((c) => c > 0).length
      expect(withCaptures).toBe(Math.min(k, 10))

      const globals = caps.map((c) => c.globalTime)
      expect([...globals]).toEqual([...globals].sort((x, y) => x - y))
      for (const c of caps) {
        const d = durations[sources.findIndex((s) => s.id === c.sourceId)]
        expect(c.localTime).toBeGreaterThanOrEqual(0)
        expect(c.localTime).toBeLessThan(d)
      }
    }
  })
})

describe('allocateSheets', () => {
  it('gives every recording ≥ 1 and sums to 10 when 1 ≤ k ≤ 10', () => {
    for (let k = 1; k <= 10; k++) {
      const durations = Array.from({ length: k }, (_, i) => 60 + i * 30)
      const out = allocateSheets(durations)
      expect(out.reduce((n, x) => n + x, 0)).toBe(10)
      expect(out.every((x) => x >= 1)).toBe(true)
    }
  })

  it('gives exactly 10 ones to the longest recordings when k > 10, ties going to the earlier one', () => {
    const durations = Array.from({ length: 11 }, () => 600) // all tied
    const out = allocateSheets(durations)
    expect(out).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0])
  })

  it('gives exactly 10 ones to the longest recordings by length when durations differ', () => {
    const durations = [5, 4, 3, 2, 1, 10, 9, 8, 7, 6, 100]
    const out = allocateSheets(durations)
    // All 11 values are distinct; "1" (index 4) is the smallest and is the only
    // one excluded from the 10 longest.
    expect(out[4]).toBe(0)
    expect(out.reduce((n, x) => n + x, 0)).toBe(10)
    expect(out[10]).toBe(1) // longest (100) always included
  })

  it('gives zero or negative durations 0', () => {
    expect(allocateSheets([0, -5, 100])).toEqual([0, 0, 10])
  })

  it('gives an empty input []', () => {
    expect(allocateSheets([])).toEqual([])
  })
})
