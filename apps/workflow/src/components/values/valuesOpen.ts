/**
 * Whether the values in one pane are open or closed, and the "Expand all"
 * that flips every one of them at once (2026-09-09 UX review).
 *
 * Every value in a pane is a disclosure, closed by default, so a pane full of
 * transcripts and image grids is a list a person can scan instead of a mile of
 * scrolling. Two facts travel together: `open` — what a value with no opinion
 * of its own should do — and `epoch`, bumped on every bulk press. A value that
 * has been opened or closed by hand keeps its own state until the next press,
 * and then rejoins the group: that is what "Expand all" has to mean, and
 * comparing epochs is what makes an already-open value close again on
 * "Collapse all" without the pane tracking a set of names.
 */
import { createContext, useContext, useState } from 'react'

export interface BulkOpen {
  /** Bumped on each bulk press; a value's own choice only counts within one. */
  epoch: number
  /** What a value with no choice of its own does. */
  open: boolean
}

export const BULK_CLOSED: BulkOpen = { epoch: 0, open: false }

const ValuesOpenContext = createContext<BulkOpen>(BULK_CLOSED)

export const ValuesOpenProvider = ValuesOpenContext.Provider

/** Read by every collapsible `ValueView`; panes that provide nothing stay closed. */
export function useBulkOpen(): BulkOpen {
  return useContext(ValuesOpenContext)
}

/** The pane side: the state to provide, and the handler for its Expand all. */
export function useValuesBulk(): { bulk: BulkOpen; toggle: () => void } {
  const [bulk, setBulk] = useState<BulkOpen>(BULK_CLOSED)
  return {
    bulk,
    toggle: () => setBulk((prev) => ({ epoch: prev.epoch + 1, open: !prev.open })),
  }
}
