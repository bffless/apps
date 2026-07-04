import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { DESKTOP_MEDIA_QUERY, matchesQuery, useMediaQuery } from './useMediaQuery'

/**
 * A controllable `MediaQueryList` fake. jsdom does not implement `matchMedia`,
 * so we install one per test and drive `change` events by hand.
 */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>()
  const mql = {
    matches: initial,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  }
  const matchMedia = vi.fn(() => mql)
  vi.stubGlobal('matchMedia', matchMedia)
  return {
    matchMedia,
    /** Flip the query result and fire `change`, as a real resize would. */
    set(next: boolean) {
      mql.matches = next
      for (const cb of listeners) cb()
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DESKTOP_MEDIA_QUERY', () => {
  it('matches Tailwind’s lg breakpoint (1024px)', () => {
    expect(DESKTOP_MEDIA_QUERY).toBe('(min-width: 1024px)')
  })
})

describe('matchesQuery', () => {
  it('reflects the underlying match', () => {
    installMatchMedia(true)
    expect(matchesQuery(DESKTOP_MEDIA_QUERY)).toBe(true)
  })

  it('returns false when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(matchesQuery(DESKTOP_MEDIA_QUERY)).toBe(false)
  })
})

describe('useMediaQuery', () => {
  it('returns the initial match', () => {
    installMatchMedia(true)
    const { result } = renderHook(() => useMediaQuery(DESKTOP_MEDIA_QUERY))
    expect(result.current).toBe(true)
  })

  it('re-renders when the query flips across the breakpoint', () => {
    const mm = installMatchMedia(false)
    const { result } = renderHook(() => useMediaQuery(DESKTOP_MEDIA_QUERY))
    expect(result.current).toBe(false)
    act(() => mm.set(true))
    expect(result.current).toBe(true)
    act(() => mm.set(false))
    expect(result.current).toBe(false)
  })

  it('unsubscribes on unmount', () => {
    const mm = installMatchMedia(true)
    const { unmount } = renderHook(() => useMediaQuery(DESKTOP_MEDIA_QUERY))
    expect(mm.listenerCount).toBe(1)
    unmount()
    expect(mm.listenerCount).toBe(0)
  })

  it('falls back to false without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useMediaQuery(DESKTOP_MEDIA_QUERY))
    expect(result.current).toBe(false)
  })
})
