import { describe, it, expect } from 'vitest'
import {
  CONTENT_MIN_SIZE,
  PAGE_SCROLL_FRACTION,
  SIDEBAR_COLLAPSED_MAX_PX,
  SIDEBAR_DEFAULT_SIZE,
  SIDEBAR_MAX_SIZE,
  SIDEBAR_MIN_SIZE,
  SIDEBAR_RAIL_PX,
  isCollapsedWidth,
  pageScrollDelta,
} from './panes'

describe('sidebar sizing bounds', () => {
  it('keeps the default within the min/max bounds', () => {
    expect(SIDEBAR_MIN_SIZE).toBeLessThanOrEqual(SIDEBAR_DEFAULT_SIZE)
    expect(SIDEBAR_DEFAULT_SIZE).toBeLessThanOrEqual(SIDEBAR_MAX_SIZE)
  })

  it('leaves the content region at least its minimum share at max sidebar', () => {
    // The widest the sidebar can grow still leaves the content min satisfiable.
    expect(SIDEBAR_MAX_SIZE + CONTENT_MIN_SIZE).toBeLessThanOrEqual(100)
  })
})

describe('isCollapsedWidth', () => {
  it('treats the icon rail width (and rounding around it) as collapsed', () => {
    expect(isCollapsedWidth(SIDEBAR_RAIL_PX)).toBe(true)
    expect(isCollapsedWidth(SIDEBAR_RAIL_PX + 1)).toBe(true)
    expect(isCollapsedWidth(SIDEBAR_COLLAPSED_MAX_PX)).toBe(true)
  })

  it('treats a zero/unmeasured width as collapsed (the safe rail default)', () => {
    expect(isCollapsedWidth(0)).toBe(true)
    expect(isCollapsedWidth(Number.NaN)).toBe(false)
  })

  it('treats a real, expanded sidebar as not collapsed', () => {
    // The narrowest expanded sidebar is SIDEBAR_MIN_SIZE% of the group, which is
    // ≳130px on any desktop viewport — comfortably above the collapsed bound.
    expect(isCollapsedWidth(SIDEBAR_COLLAPSED_MAX_PX + 1)).toBe(false)
    expect(isCollapsedWidth(130)).toBe(false)
    expect(isCollapsedWidth(300)).toBe(false)
  })

  it('keeps the collapsed bound clear of the smallest expanded sidebar', () => {
    // Rail width < bound guarantees the rail reads as collapsed; the bound sits
    // well under 14% of even a 1024px-wide desktop group (~130px).
    expect(SIDEBAR_RAIL_PX).toBeLessThan(SIDEBAR_COLLAPSED_MAX_PX)
    expect(SIDEBAR_COLLAPSED_MAX_PX).toBeLessThan((SIDEBAR_MIN_SIZE / 100) * 1024)
  })
})

describe('pageScrollDelta', () => {
  it('scrolls just under a full container height', () => {
    expect(pageScrollDelta(1000)).toBe(Math.round(1000 * PAGE_SCROLL_FRACTION))
    expect(pageScrollDelta(1000)).toBeLessThan(1000)
  })

  it('rounds to whole pixels', () => {
    expect(Number.isInteger(pageScrollDelta(777))).toBe(true)
  })

  it('clamps a zero-height or unmeasured container to no scroll', () => {
    expect(pageScrollDelta(0)).toBe(0)
    expect(pageScrollDelta(-50)).toBe(0)
    expect(pageScrollDelta(Number.NaN)).toBe(0)
  })
})
