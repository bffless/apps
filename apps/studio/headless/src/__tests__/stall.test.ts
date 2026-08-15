import { describe, it, expect } from 'vitest'
import { createStallWatch } from '../stall'

const MIN = 60_000

describe('createStallWatch', () => {
  const watch = () => createStallWatch({ shotEveryMs: 10 * MIN, failAfterMs: 20 * MIN, maxShots: 5 })

  it('stays quiet while the description keeps changing', () => {
    const w = watch()
    expect(w.observe('scene 1 — cut running', 0).action).toBe('none')
    expect(w.observe('scene 1 — refine running', 15 * MIN).action).toBe('none')
    expect(w.observe('scene 1 — assemble running', 30 * MIN).action).toBe('none')
  })

  it('asks for a screenshot once the line has been frozen for the shot interval', () => {
    const w = watch()
    w.observe('scene 1 — assemble running', 0)
    expect(w.observe('scene 1 — assemble running', 9 * MIN).action).toBe('none')
    expect(w.observe('scene 1 — assemble running', 10 * MIN)).toMatchObject({ action: 'shot', shot: 1 })
    // ...and not again until the next interval elapses
    expect(w.observe('scene 1 — assemble running', 11 * MIN).action).toBe('none')
  })

  it('fails the run once the freeze outlasts the ceiling', () => {
    const w = watch()
    w.observe('scene 1 — assemble running', 0)
    w.observe('scene 1 — assemble running', 10 * MIN)
    const verdict = w.observe('scene 1 — assemble running', 20 * MIN)
    expect(verdict.action).toBe('fail')
    expect(verdict.stalledMs).toBe(20 * MIN)
  })

  it('a change resets the clock — a slow but moving build never fails', () => {
    const w = watch()
    w.observe('scene 1 — assemble running', 0)
    w.observe('scene 1 — assemble running', 19 * MIN)
    w.observe('scene 2 — cut running', 19 * MIN + 1) // progress
    // The new line gets the full budget of its own: a shot at 10m, fail at 20m.
    expect(w.observe('scene 2 — cut running', 29 * MIN + 2)).toMatchObject({ action: 'shot', shot: 1 })
    expect(w.observe('scene 2 — cut running', 39 * MIN + 2).action).toBe('fail')
  })

  it('caps screenshots so a very high ceiling cannot flood the artifacts', () => {
    const w = createStallWatch({ shotEveryMs: 1 * MIN, failAfterMs: 60 * MIN, maxShots: 2 })
    w.observe('frozen', 0)
    expect(w.observe('frozen', 1 * MIN).action).toBe('shot')
    expect(w.observe('frozen', 2 * MIN).action).toBe('shot')
    expect(w.observe('frozen', 3 * MIN).action).toBe('none')
  })
})
