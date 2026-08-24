/**
 * The pane's half of the handle lookup (Task 5).
 *
 * The registry in `store/islandLaunch` is module-level, not Redux state — a
 * live `AppBridge` is not serialisable and has no business in a store — so a
 * component cannot find it with `useSelector`. `useSyncExternalStore` over the
 * registry's own version counter gives the pane the one thing it does need:
 * a re-render when a handle appears (Resume registers handles from a listener
 * effect, after the page has already rendered) or when a log line lands.
 */
import { useSyncExternalStore } from 'react'
import type { StepKey } from '../lib/runner/types'
import {
  getIslandHandle,
  islandHandlesVersion,
  subscribeIslandHandles,
} from '../store/islandLaunch'
import type { IslandHandle } from '../store/islandLaunch'

export function useIslandHandle(runId: string, key: StepKey): IslandHandle | undefined {
  useSyncExternalStore(subscribeIslandHandles, islandHandlesVersion, islandHandlesVersion)
  return getIslandHandle(runId, key)
}
