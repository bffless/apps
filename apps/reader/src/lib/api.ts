/**
 * Thin client for the Rivulet `/api/*` backend (a BFFless proxy-rule-set, not a
 * server). Every call goes through {@link fetchWithReauth} so an expired
 * SuperTokens access token transparently refreshes and retries. Response shaping
 * lives in the pure `lib/{feeds,items}` modules; this file only does transport
 * + minimal request assembly, so it stays below the unit-test seam.
 */

import { fetchWithReauth } from './session'
import { shapeFeed, normalizeFeedUrl, type Feed, type RawFeed } from './feeds'
import { shapeItem, type Item, type RawItem } from './items'
import { resolveFeedUrl, type DiscoveredFeed, type FetchedPage } from './discover'
import { buildItemsQuery, viewOf, type SortOrder, PAGE_SIZE } from './itemsQuery'
import type { Selection } from './river'

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) {
    let detail = ''
    try {
      detail = await res.text()
    } catch {
      // ignore — the status is enough to act on
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`)
  }
  return res.json()
}

function asArray(body: unknown, key: string): unknown[] {
  if (Array.isArray(body)) return body
  if (body && typeof body === 'object') {
    const v = (body as Record<string, unknown>)[key]
    if (Array.isArray(v)) return v
  }
  return []
}

/** List every subscribed feed. */
export async function listFeeds(): Promise<Feed[]> {
  const body = await readJson(await fetchWithReauth('/api/feeds'))
  return asArray(body, 'feeds').map((r) => shapeFeed(r as RawFeed))
}

/**
 * Subscribe to a feed by URL. The URL is normalized client-side so the server's
 * `data_upsert_many` dedup-by-url sees the same key we'd compute on a re-add.
 * Throws on an empty/invalid URL before hitting the network.
 */
export async function addFeed(input: {
  url: string
  title?: string
  siteUrl?: string
  folder?: string | null
}): Promise<Feed> {
  const url = normalizeFeedUrl(input.url)
  if (!url) throw new Error('Enter a valid feed URL')
  const body = await readJson(
    await fetchWithReauth('/api/feeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        title: input.title ?? '',
        siteUrl: input.siteUrl ?? '',
        folder: input.folder ?? null,
        addedAt: Date.now(),
      }),
    }),
  )
  const feed = (body && typeof body === 'object' && 'feed' in body ? (body as { feed: unknown }).feed : body) as RawFeed
  return shapeFeed({ url, ...(feed && typeof feed === 'object' ? feed : {}) })
}

/**
 * Fetch a page's body for feed discovery through the `/api/discover`
 * `http_request` proxy (dodging CORS — CONTEXT D12). The proxy answers 200 with
 * a JSON envelope `{ body, status, ok }` — the upstream body as a string, so a
 * common-path probe's 404 is *data* (ok:false, non-feed body), not a transport
 * error that aborts the sweep. The pure `lib/discover` helpers sniff/parse the
 * body; a 401/403 on the proxy itself is a real auth failure worth surfacing.
 */
async function discoverPage(url: string): Promise<FetchedPage> {
  const res = await fetchWithReauth('/api/discover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error('Sign in to discover feeds')
  }
  let body = ''
  let upstreamOk = res.ok
  try {
    const env = await res.json()
    if (env && typeof env === 'object') {
      const e = env as Record<string, unknown>
      if (typeof e.body === 'string') body = e.body
      if (typeof e.ok === 'boolean') upstreamOk = e.ok
    }
  } catch {
    // A non-JSON body (e.g. a proxy error page) leaves body empty — discovery
    // then finds nothing and reports "No feed found", which is the right signal.
  }
  return { url, body, contentType: null, ok: upstreamOk }
}

/**
 * Resolve a pasted URL — a site homepage or a feed — to a subscribable feed URL.
 * If it's already a feed it's returned as-is; otherwise the page's alternate
 * link, then well-known feed paths, are tried (all logic in tested `lib/discover`).
 */
export function discoverFeed(input: string): Promise<DiscoveredFeed> {
  return resolveFeedUrl(input, discoverPage)
}

/**
 * Move a feed into a folder (or out of one, with `folder: null`). The add
 * endpoint's `data_upsert_many` is insert-only (dedup by url, existing rows left
 * untouched — ce#407), so it can never *change* an existing feed's folder. This
 * instead hits the dedicated update path `POST /api/feeds/folder`
 * (`data_query by url → data_update({ folder })`, mirroring `/api/items/read`),
 * sending only `{ url, folder }`. Every other per-feed field (icon, last-fetch,
 * item read/star state) is left intact because the update writes just `folder`.
 */
export async function setFeedFolder(feed: Feed, folder: string | null): Promise<void> {
  if (!feed.url) throw new Error('feed url is required')
  await readJson(
    await fetchWithReauth('/api/feeds/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: feed.url,
        folder: folder && folder.trim() ? folder.trim() : null,
      }),
    }),
  )
}

/** Unsubscribe: remove a feed by URL. Items are left in place (they age out via retention). */
export async function removeFeed(url: string): Promise<void> {
  await readJson(
    await fetchWithReauth('/api/feeds/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
  )
}

export type ItemsPage = { items: Item[]; total: number; page: number; pageSize: number; totalPages: number }

/** Fetch one filtered, paginated page for a selection (see lib/itemsQuery). */
export async function listItems(
  sel: Selection,
  opts: { page?: number; limit?: number; order?: SortOrder; total?: number | null } = {},
): Promise<ItemsPage> {
  const page = opts.page ?? 1
  const limit = opts.limit ?? PAGE_SIZE
  const { params, reverse } = buildItemsQuery(sel, page, limit, opts.order ?? 'newest', opts.total ?? null)
  const body = await readJson(await fetchWithReauth(`/api/items?${params.toString()}`))
  const b = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Record<string, unknown>
  const num = (v: unknown, d: number) => (typeof v === 'number' && !Number.isNaN(v) ? v : d)
  const items = asArray(body, 'items').map((r) => shapeItem(r as RawItem))
  if (reverse) items.reverse()
  return {
    items,
    total: num(b.total, items.length),
    page: num(b.page, page),
    pageSize: num(b.pageSize, limit),
    totalPages: num(b.totalPages, 1),
  }
}

export type Counts = { unreadByFeed: Record<string, number>; starred: number; unreadStarred: number }

/** Fetch unread-by-feed and starred counts for sidebar badges. */
export async function getCounts(): Promise<Counts> {
  const body = await readJson(await fetchWithReauth('/api/counts'))
  const b = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Record<string, unknown>
  const unreadByFeed =
    b.unreadByFeed && typeof b.unreadByFeed === 'object' ? (b.unreadByFeed as Record<string, number>) : {}
  const starred = typeof b.starred === 'number' && !Number.isNaN(b.starred) ? b.starred : 0
  const unreadStarred = typeof b.unreadStarred === 'number' && !Number.isNaN(b.unreadStarred) ? b.unreadStarred : 0
  return { unreadByFeed, starred, unreadStarred }
}

/**
 * Mark every item in a selection's view as read in one server-side pass.
 * Returns the number of rows updated.
 */
export async function markAllRead(sel: Selection): Promise<number> {
  const payload: Record<string, unknown> = { view: viewOf(sel) }
  if (sel.kind === 'feed') payload.feedId = sel.url
  if (sel.kind === 'folder') payload.folder = sel.name
  const body = await readJson(
    await fetchWithReauth('/api/items/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
  const b = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Record<string, unknown>
  return typeof b.updated === 'number' && !Number.isNaN(b.updated) ? b.updated : 0
}

/** Fetch a single item by guid (deep-link), or null if it doesn't exist. */
export async function getItem(guid: string): Promise<Item | null> {
  const params = new URLSearchParams()
  params.set('guid', guid)
  const body = await readJson(await fetchWithReauth(`/api/items?${params.toString()}`))
  const items = asArray(body, 'items')
  return items.length > 0 ? shapeItem(items[0] as RawItem) : null
}

/**
 * Persist an item's `read` flag via `data_update` (looked up by `guid`). The UI
 * updates optimistically, so this is fire-and-confirm: it resolves on success
 * and throws on failure, letting the caller revert. Mark-all-read fans this out
 * over a view's unread guids — there's no bulk primitive, and at personal scale
 * a handful of parallel writes is fine.
 */
export async function setItemRead(guid: string, read: boolean): Promise<void> {
  if (!guid) throw new Error('guid is required')
  await readJson(
    await fetchWithReauth('/api/items/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid, read }),
    }),
  )
}

/**
 * Persist an item's `starred` flag via `data_update` (looked up by `guid`) — the
 * `/api/items/star` twin of {@link setItemRead}. The UI stars optimistically, so
 * this resolves on success and throws on failure, letting the caller revert.
 * A starred item is prune-exempt (#119) — the flag survives refresh + retention.
 */
export async function setItemStar(guid: string, starred: boolean): Promise<void> {
  if (!guid) throw new Error('guid is required')
  await readJson(
    await fetchWithReauth('/api/items/star', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guid, starred }),
    }),
  )
}

export type RefreshResult = { inserted: number; skipped: number; errors: number }

/**
 * Trigger the ingest pipeline (`data_query → xml_feed_parse → data_upsert_many`)
 * on demand. Returns whatever counts the pipeline reports, best-effort.
 */
export async function refresh(): Promise<RefreshResult> {
  const body = await readJson(await fetchWithReauth('/api/refresh', { method: 'POST' }))
  const b = (body && typeof body === 'object' ? (body as Record<string, unknown>) : {}) as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && !Number.isNaN(v) ? v : 0)
  return { inserted: n(b.inserted), skipped: n(b.skipped), errors: n(b.errors) }
}
