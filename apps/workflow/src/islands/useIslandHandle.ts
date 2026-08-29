/**
 * The pane's half of the handle lookup (Task 5).
 *
 * The registry in `store/islandLaunch` is module-level, not Redux state — a
 * live `AppBridge` is not serialisable and has no business in a store — so a
 * component cannot find it with `useSelector`. `useSyncExternalStore` over the
 * registry gives the pane a re-render when a handle appears (Resume registers
 * handles from a listener effect, after the page has already rendered) or when
 * a log line lands.
 *
 * Both hooks return **the snapshot itself** (apps#370): the handle, whose
 * identity is stable for the life of the step, and the log, which the registry
 * replaces with a fresh array per line. A version counter as the snapshot with
 * the real value read on the side works only by accident of ordering and can
 * tear under concurrent rendering.
 */
import { useSyncExternalStore } from 'react'
import type { StepKey } from '../lib/runner/types'
import { getIslandHandle, subscribeIslandHandles } from '../store/islandLaunch'
import type { IslandHandle } from '../store/islandLaunch'

const NO_LOG: readonly string[] = []

export function useIslandHandle(runId: string, key: StepKey): IslandHandle | undefined {
  return useSyncExternalStore(
    subscribeIslandHandles,
    () => getIslandHandle(runId, key),
    () => getIslandHandle(runId, key),
  )
}

/** The handle's `ui/message` lines — a new array per line, `[]` with no handle. */
export function useIslandLog(runId: string, key: StepKey): readonly string[] {
  const read = () => getIslandHandle(runId, key)?.log ?? NO_LOG
  return useSyncExternalStore(subscribeIslandHandles, read, read)
}
