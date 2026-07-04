import { describe, it, expect } from 'vitest'
import {
  CONTENT_MIN_SIZE,
  COLLAPSED_THRESHOLD,
  PAGE_SCROLL_FRACTION,
  SIDEBAR_DEFAULT_SIZE,
  SIDEBAR_MAX_SIZE,
  SIDEBAR_MIN_SIZE,
  isCollapsedSize,
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

describe('isCollapsedSize', () => {
  it('treats a fully collapsed (0%) panel as collapsed', () => {
    expect(isCollapsedSize(0)).toBe(true)
  })

  it('absorbs sub-pixel rounding at the threshold', () => {
    expect(isCollapsedSize(COLLAPSED_THRESHOLD)).toBe(true)
    expect(isCollapsedSize(COLLAPSED_THRESHOLD - 0.1)).toBe(true)
  })

  it('treats a real, narrow sidebar as expanded', () => {
    expect(isCollapsedSize(SIDEBAR_MIN_SIZE)).toBe(false)
    expect(isCollapsedSize(SIDEBAR_DEFAULT_SIZE)).toBe(false)
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
