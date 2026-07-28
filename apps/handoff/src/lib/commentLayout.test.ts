/**
 * Card-layout engine for the comment gutter (Task 9, spec §5 "Alignment
 * engine"). Pure function of (cards, activeId, gap) → document-space tops, so
 * the Google-Docs clustering behaviour is unit-testable without a DOM.
 */
import { describe, it, expect } from 'vitest'
import { layoutCards } from './commentLayout'

const card = (id: string, anchorY: number, height = 80) => ({ id, anchorY, height })

describe('layoutCards', () => {
  it('keeps non-overlapping cards at their anchors', () => {
    const m = layoutCards([card('a', 0), card('b', 200)], null)
    expect(m.get('a')).toBe(0); expect(m.get('b')).toBe(200)
  })
  it('pushes overlapping cards down with the gap', () => {
    const m = layoutCards([card('a', 100), card('b', 120)], null, 8)
    expect(m.get('a')).toBe(100); expect(m.get('b')).toBe(100 + 80 + 8)
  })
  it('active card is pinned at its anchor; earlier cards are pushed up', () => {
    const m = layoutCards([card('a', 100), card('b', 130)], 'b', 8)
    expect(m.get('b')).toBe(130)
    expect(m.get('a')).toBe(130 - 8 - 80) // pushed above the active card
  })
  it('input order does not matter (sorts by anchorY)', () => {
    const m = layoutCards([card('b', 200), card('a', 0)], null)
    expect(m.get('a')).toBe(0)
  })
  it('never returns negative tops', () => {
    const m = layoutCards([card('a', 0), card('b', 10)], 'b')
    expect(m.get('a')).toBeGreaterThanOrEqual(0)
  })
})
