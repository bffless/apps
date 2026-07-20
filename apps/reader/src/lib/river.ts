/**
 * Selection identity + read/starred/unread transition logic — pure, so it's the
 * tested seam for story #114. A **selection** (the river, all feeds, or one
 * feed) identifies what the component is viewing; the server-paginated item
 * page is fetched separately (see `itemsQuery`/`api`). Read state is toggled
 * with immutable transitions so the UI can update optimistically before the
 * write lands and revert on failure, calling the persistence seam
 * (`data_update` via `api.setItemRead`).
 *
 * The **river** is the unread stream across every feed (D-river): read items
 * drop out of it but stay queryable in the "all"/per-feed views — nothing is
 * deleted here (retention is #119).
 *
 * Star state (#115) rides the same rails: {@link setStarred} is the immutable
 * transition, and the `starred` selection scopes the saved-items view —
 * persisted via `data_update` at the same seam as read.
 */

import type { Item } from './items'

/** What the sidebar has selected. */
export type Selection =
  | { kind: 'river' } // unread items across all feeds — the default landing view
  | { kind: 'all' } // every item across all feeds (read included)
  | { kind: 'starred' } // saved items across all feeds — the "keep it forever" view (#115)
  | { kind: 'feed'; url: string } // every item in one feed (its `feedId`)
  | { kind: 'folder'; name: string } // every item across the feeds in one folder (#116)

/** A stable string key for a selection — for React keys / equality. */
export function selectionKey(sel: Selection): string {
  if (sel.kind === 'feed') return `feed:${sel.url}`
  if (sel.kind === 'folder') return `folder:${sel.name}`
  return sel.kind
}

/** Whether two selections point at the same view. */
export function selectionEquals(a: Selection, b: Selection): boolean {
  return selectionKey(a) === selectionKey(b)
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
 * Set the `starred` flag on the item with `guid`, returning a new array (only the
 * one item's identity changes). Same optimistic, non-mutating shape as
 * {@link setRead}; a no-op guid or matching flag leaves references untouched.
 * Starred items are prune-exempt (#119) — the flag is the "keep it forever" mark.
 */
export function setStarred(items: Item[], guid: string, starred: boolean): Item[] {
  return items.map((item) =>
    item.guid === guid && item.starred !== starred ? { ...item, starred } : item,
  )
}

/**
 * Set the `archived` flag on the item with `guid`, returning a new array (only
 * the one item's identity changes). Same optimistic, non-mutating shape as
 * {@link setStarred}. Archived items are hidden from views by default and are
 * prune-exempt; the flag survives refresh (insert-only dedup skips the guid).
 */
export function setArchived(items: Item[], guid: string, archived: boolean): Item[] {
  return items.map((item) =>
    item.guid === guid && item.archived !== archived ? { ...item, archived } : item,
  )
}

/**
 * The rows a view actually renders. Archived items are hidden unless the view
 * asked for them, which is what makes an optimistic {@link setArchived} flip
 * take the row out of the list right away — the server's `includeArchived`
 * filter only applies to the *next* fetch, so without this the row would linger
 * in the loaded snapshot until a nav or reload. Applies in both directions:
 * un-archiving from the "Show archived" view drops the row just the same.
 */
export function visibleItems(items: Item[], showArchived: boolean): Item[] {
  return showArchived ? items : items.filter((item) => !item.archived)
}

/**
 * Drop the item with `guid` from the array (what a hard delete commits locally),
 * returning a new array. An unknown guid leaves the array contents untouched.
 */
export function removeItem(items: Item[], guid: string): Item[] {
  return items.filter((item) => item.guid !== guid)
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
