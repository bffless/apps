import { describe, it, expect } from 'vitest'
import { planGlobalSheetCaptures } from './globalSheet'

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
