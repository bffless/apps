/**
 * Folder organization for feeds — pure, so it's the tested seam for story #116.
 *
 * A feed carries a nullable `folder` string (null = uncategorized). Folders are
 * matched **case-insensitively** (so `News` and `news` are one folder) while a
 * display label is preserved from the first feed that named it. Grouping, the
 * per-folder unread rollup, and folder-name discovery all live here; the sidebar
 * only renders what these return. Moving a feed between folders updates just the
 * feed row's `folder` via `POST /api/feeds/folder` (see `api.setFeedFolder`) — a
 * `data_update`, not an upsert, since the add endpoint is insert-only (ce#407).
 */

import { sortFeeds, type Feed } from './feeds'

/** A folder and its feeds. `folder: null` is the uncategorized group. */
export type FolderGroup = { folder: string | null; feeds: Feed[] }

/** Normalize user-entered folder text: trim, and treat empty as uncategorized. */
export function normalizeFolder(input: string): string | null {
  const trimmed = (input ?? '').trim()
  return trimmed ? trimmed : null
}

/**
 * The distinct folder names in use, sorted case-insensitively (nulls excluded).
 * When the same name appears in mixed case, the first-seen label is kept — this
 * feeds the "move to folder" picker so it offers existing folders to merge into.
 */
export function folderNames(feeds: Feed[]): string[] {
  const byKey = new Map<string, string>() // lowercased key -> first-seen label
  for (const f of feeds) {
    if (f.folder == null) continue
    const key = f.folder.toLocaleLowerCase()
    if (!byKey.has(key)) byKey.set(key, f.folder)
  }
  return [...byKey.values()].sort((a, b) =>
    a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()),
  )
}

/**
 * Group feeds by folder: named folders first (sorted case-insensitively by
 * label), then a single uncategorized group — and only if uncategorized feeds
 * exist. Feeds within each group are label-sorted (shared `sortFeeds`).
 */
export function groupFeedsByFolder(feeds: Feed[]): FolderGroup[] {
  const named = new Map<string, { label: string; feeds: Feed[] }>()
  const uncategorized: Feed[] = []
  for (const f of feeds) {
    if (f.folder == null) {
      uncategorized.push(f)
      continue
    }
    const key = f.folder.toLocaleLowerCase()
    let group = named.get(key)
    if (!group) {
      group = { label: f.folder, feeds: [] }
      named.set(key, group)
    }
    group.feeds.push(f)
  }
  const groups: FolderGroup[] = [...named.values()]
    .sort((a, b) => a.label.toLocaleLowerCase().localeCompare(b.label.toLocaleLowerCase()))
    .map((g) => ({ folder: g.label, feeds: sortFeeds(g.feeds) }))
  if (uncategorized.length) groups.push({ folder: null, feeds: sortFeeds(uncategorized) })
  return groups
}

/**
 * The set of feed urls (= `feedId`) belonging to a folder, matched
 * case-insensitively; `folder: null` collects the uncategorized feeds. This is
 * how a per-folder item view scopes the shared item set.
 */
export function feedUrlsInFolder(feeds: Feed[], folder: string | null): Set<string> {
  const key = folder == null ? null : folder.toLocaleLowerCase()
  const urls = new Set<string>()
  for (const f of feeds) {
    const fk = f.folder == null ? null : f.folder.toLocaleLowerCase()
    if (fk === key) urls.add(f.url)
  }
  return urls
}

/** Roll a group's per-feed unread counts up into one folder total. */
export function folderUnread(unreadByFeed: Record<string, number>, feeds: Feed[]): number {
  return feeds.reduce((n, f) => n + (unreadByFeed[f.url] ?? 0), 0)
}
