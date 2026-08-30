/**
 * The pane-level **Show raw** (08, apps#450): every value in the Input/Output
 * panes as the raw JSON its row holds, for the person who wants exactly the
 * data and no inference in the way. One switch for the whole browser,
 * remembered in `localStorage` — a power user flips it once. Storage is a
 * best effort: with none (private mode, a quota, a sandboxed frame) the
 * choice lasts the session.
 *
 * A module store rather than Redux state: it is a viewing preference of this
 * browser, not a fact about any run, and `runSlice` rebuilds from rows.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'workflow:show-raw'

let current: boolean | null = null
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function get(): boolean {
  if (current === null) current = read()
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setShowRaw(on: boolean): void {
  current = on
  try {
    window.localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // Nowhere to remember it — the choice still holds until the tab closes.
  }
  for (const listener of listeners) listener()
}

/**
 * Tests only: forget the choice and whatever storage holds. Quietly — a
 * subscriber still mounted would otherwise re-read (and re-cache) storage
 * before the next test has seeded it.
 */
export function resetShowRaw(): void {
  current = null
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}

/** Whether the panes are showing raw JSON right now. */
export function useShowRaw(): boolean {
  return useSyncExternalStore(subscribe, get, () => false)
}
