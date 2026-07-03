/**
 * River + read/unread + unread-count logic — pure, so it's the tested seam for
 * story #114. A **selection** (the river, all feeds, or one feed) plus the loaded
 * item set is enough to derive the display list and every unread count; the
 * component just renders what these functions return and calls the persistence
 * seam (`data_update` via `api.setItemRead`). Read state is toggled with
 * immutable transitions so the UI can update optimistically before the write
 * lands and revert on failure.
 *
 * The **river** is the unread stream across every feed (D-river): read items
 * drop out of it but stay queryable in the "all"/per-feed views — nothing is
 * deleted here (retention is #119).
 */

import { sortItemsNewestFirst, type Item } from './items'

/** What the sidebar has selected. */
export type Selection =
  | { kind: 'river' } // unread items across all feeds — the default landing view
  | { kind: 'all' } // every item across all feeds (read included)
  | { kind: 'feed'; url: string } // every item in one feed (its `feedId`)

/** A stable string key for a selection — for React keys / equality. */
export function selectionKey(sel: Selection): string {
  return sel.kind === 'feed' ? `feed:${sel.url}` : sel.kind
}

/** Whether two selections point at the same view. */
export function selectionEquals(a: Selection, b: Selection): boolean {
  return selectionKey(a) === selectionKey(b)
}

/**
 * The ordered list to display for a selection, derived client-side from the full
 * loaded set: the river filters to unread; a feed scopes to its `feedId`; all
 * passes everything. Always newest-first (shared comparator with the per-feed
 * list). Non-mutating.
 */
export function itemsForSelection(items: Item[], sel: Selection): Item[] {
  let scoped = items
  if (sel.kind === 'feed') scoped = items.filter((i) => i.feedId === sel.url)
  if (sel.kind === 'river') scoped = scoped.filter((i) => !i.read)
  return sortItemsNewestFirst(scoped)
}

/** Unread count keyed by `feedId`, over the whole set. Feeds with none are omitted. */
export function unreadCountsByFeed(items: Item[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    if (item.read) continue
    counts[item.feedId] = (counts[item.feedId] ?? 0) + 1
  }
  return counts
}

/** Total unread across all feeds — the river's badge. */
export function totalUnread(items: Item[]): number {
  return items.reduce((n, item) => (item.read ? n : n + 1), 0)
}

/**
 * Set the `read` flag on the item with `guid`, returning a new array (the item
 * identity changes only for the one that moved). A no-op guid leaves the array
 * contents untouched.
 */
export function setRead(items: Item[], guid: string, read: boolean): Item[] {
  return items.map((item) => (item.guid === guid && item.read !== read ? { ...item, read } : item))
}

/**
 * Mark every listed guid read in one pass — what "mark all read (this view)"
 * commits locally. Already-read items are left as-is so identities stay stable.
 */
export function markGuidsRead(items: Item[], guids: Iterable<string>): Item[] {
  const set = guids instanceof Set ? guids : new Set(guids)
  return items.map((item) => (set.has(item.guid) && !item.read ? { ...item, read: true } : item))
}

/**
 * The unread guids among a (already-scoped) list — the set "mark all read" and
 * scroll-past act on, and what the caller persists. Preserves input order.
 */
export function unreadGuids(items: Item[]): string[] {
  return items.filter((item) => !item.read).map((item) => item.guid)
}
