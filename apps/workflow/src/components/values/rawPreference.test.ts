/**
 * The pane-level Show raw preference (08, apps#450): one store, remembered
 * in localStorage, and never a crash when storage is missing or refuses.
 */
import { renderHook, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetShowRaw, setShowRaw, useShowRaw } from './rawPreference'

afterEach(() => {
  vi.restoreAllMocks()
  resetShowRaw()
})

describe('rawPreference', () => {
  it('starts off, flips every subscriber at once, and remembers the choice', () => {
    const a = renderHook(() => useShowRaw())
    const b = renderHook(() => useShowRaw())
    expect(a.result.current).toBe(false)

    act(() => setShowRaw(true))
    expect(a.result.current).toBe(true)
    expect(b.result.current).toBe(true)
    expect(window.localStorage.getItem('workflow:show-raw')).toBe('1')

    act(() => setShowRaw(false))
    expect(b.result.current).toBe(false)
    expect(window.localStorage.getItem('workflow:show-raw')).toBe('0')
  })

  it('reads a remembered choice on first use', () => {
    window.localStorage.setItem('workflow:show-raw', '1')
    const { result } = renderHook(() => useShowRaw())
    expect(result.current).toBe(true)
  })

  it('works with no usable storage — the choice just lasts the session', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const { result } = renderHook(() => useShowRaw())
    expect(result.current).toBe(false)
    expect(() => act(() => setShowRaw(true))).not.toThrow()
    expect(result.current).toBe(true)
  })
})
