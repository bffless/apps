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

/** Query stored items, optionally scoped to one feed (by its URL = `feedId`). */
export async function listItems(feedId?: string): Promise<Item[]> {
  const path = feedId ? `/api/items?feedId=${encodeURIComponent(feedId)}` : '/api/items'
  const body = await readJson(await fetchWithReauth(path))
  return asArray(body, 'items').map((r) => shapeItem(r as RawItem))
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
