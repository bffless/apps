/**
 * The pane's two registry hooks (apps#370): `useIslandHandle` returns the
 * registry's handle *as its `useSyncExternalStore` snapshot* (not a version
 * counter it happens to re-render on), and `useIslandLog` is the separate,
 * immutable snapshot of the handle's `ui/message` lines.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getIslandHandle } from '../store/islandLaunch'
import { ISLAND_KEY, flush, resetIslandHarness, startIslandRun } from '../test/islandHarness'
import { useIslandHandle, useIslandLog } from './useIslandHandle'

afterEach(() => {
  resetIslandHarness()
})

describe('useIslandHandle', () => {
  it('returns the registered handle, and undefined for a key with none', async () => {
    const { runId } = await startIslandRun()

    const { result } = renderHook(() => useIslandHandle(runId, ISLAND_KEY))
    expect(result.current).toBe(getIslandHandle(runId, ISLAND_KEY))

    const none = renderHook(() => useIslandHandle(runId, 'a/0/other'))
    expect(none.result.current).toBeUndefined()
  })

  it('keeps the same handle across log lines — a line is not a new island', async () => {
    const { runId, host } = await startIslandRun()
    const { result } = renderHook(() => useIslandHandle(runId, ISLAND_KEY))
    const before = result.current

    await act(async () => {
      host.deps!.onLog('rendered')
      await flush()
    })

    expect(result.current).toBe(before)
  })
})

describe('useIslandLog', () => {
  it('re-renders with each ui/message line, as a fresh array', async () => {
    const { runId, host } = await startIslandRun()
    const { result } = renderHook(() => useIslandLog(runId, ISLAND_KEY))
    expect(result.current).toEqual([])
    const first = result.current

    await act(async () => {
      host.deps!.onLog('one')
      await flush()
    })
    expect(result.current).toEqual(['one'])
    expect(result.current).not.toBe(first)

    await act(async () => {
      host.deps!.onLog('two')
      await flush()
    })
    expect(result.current).toEqual(['one', 'two'])
  })
})
