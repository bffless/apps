/**
 * `MediaSeekContext` (Task 15) on its own terms — the registry the transcript
 * → player wiring rests on, tested here rather than only through the two
 * components that happen to use it (apps#380).
 *
 * The rules that matter: first-registered wins, unregistering removes exactly
 * that element, a provider with no player answers `false` rather than
 * throwing, and `useMediaSeek` outside any provider is a working no-op — the
 * case every `FileCard` rendered outside a transcript's scope relies on.
 */
import { act, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MediaSeekProvider, useMediaSeek } from './MediaSeekContext'
import type { ReactNode } from 'react'

const wrapper = ({ children }: { children: ReactNode }) => (
  <MediaSeekProvider>{children}</MediaSeekProvider>
)

/** A detached media element — nothing here needs one in the document. */
const player = () => document.createElement('video')

describe('MediaSeekContext', () => {
  it('seeks the first registered element, not the last', () => {
    const { result } = renderHook(() => useMediaSeek(), { wrapper })
    const first = player()
    const second = player()
    act(() => {
      result.current.register(first)
      result.current.register(second)
    })

    expect(result.current.seek(42)).toBe(true)
    expect(first.currentTime).toBe(42)
    expect(second.currentTime).toBe(0)
  })

  it('falls through to the next element once the first unregisters', () => {
    const { result } = renderHook(() => useMediaSeek(), { wrapper })
    const first = player()
    const second = player()
    let drop: () => void = () => {}
    act(() => {
      drop = result.current.register(first)
      result.current.register(second)
    })

    act(() => drop())

    expect(result.current.seek(7)).toBe(true)
    expect(second.currentTime).toBe(7)
    expect(first.currentTime).toBe(0)
  })

  it('unregistering removes only that element, even when registered twice', () => {
    const { result } = renderHook(() => useMediaSeek(), { wrapper })
    const only = player()
    let drop: () => void = () => {}
    act(() => {
      drop = result.current.register(only)
    })

    act(() => {
      drop()
      drop()
    })

    expect(result.current.seek(3)).toBe(false)
    expect(only.currentTime).toBe(0)
  })

  it('answers false when the provider has no player registered', () => {
    const { result } = renderHook(() => useMediaSeek(), { wrapper })
    expect(result.current.seek(10)).toBe(false)
  })

  it('is a working no-op with no provider in the tree', () => {
    const { result } = renderHook(() => useMediaSeek())
    const orphan = player()

    expect(() => result.current.register(orphan)()).not.toThrow()
    expect(result.current.seek(5)).toBe(false)
    expect(orphan.currentTime).toBe(0)
  })

  it('keeps one stable api object across re-renders', () => {
    const { result, rerender } = renderHook(() => useMediaSeek(), { wrapper })
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('scopes registration to its own provider', () => {
    function Player({ testId }: { testId: string }) {
      const { register } = useMediaSeek()
      return <video data-testid={testId} ref={(el) => void (el && register(el))} />
    }
    function Seeker({ at }: { at: number }) {
      const { seek } = useMediaSeek()
      return (
        <button type="button" onClick={() => seek(at)}>
          seek
        </button>
      )
    }

    render(
      <>
        <MediaSeekProvider>
          <Player testId="in-scope" />
          <Seeker at={11} />
        </MediaSeekProvider>
        <MediaSeekProvider>
          <Player testId="other-scope" />
        </MediaSeekProvider>
      </>,
    )

    act(() => screen.getByRole('button').click())

    expect((screen.getByTestId('in-scope') as HTMLVideoElement).currentTime).toBe(11)
    expect((screen.getByTestId('other-scope') as HTMLVideoElement).currentTime).toBe(0)
  })
})
