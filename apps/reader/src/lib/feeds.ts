/**
 * Feed domain types + pure helpers.
 *
 * A **feed** is a followed RSS/Atom source. It is deduped by `url` (D8/D12), so
 * `url` — after normalization — is the stable identity used both as the upsert
 * dedup key and as the `feedId` foreign key on items. Keeping the URL handling
 * here (pure, tested) means the add-feed flow and OPML import (#117) share one
 * definition of "the same feed."
 */

/** A feed as the client uses it. `url` is the identity; `folder` null = uncategorized. */
export type Feed = {
  url: string
  title: string
  siteUrl: string | null
  folder: string | null
  iconUrl: string | null
  lastFetchedAt: number | null
  lastError: string | null
  addedAt: number | null
}

/** The loosely-typed shape a `/api/feeds` row arrives as (all fields optional/unknown). */
export type RawFeed = Record<string, unknown>

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && !Number.isNaN(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  return null
}

/**
 * Normalize a user-entered feed URL into its canonical form for dedup.
 *
 * - trims surrounding whitespace,
 * - defaults a missing scheme to `https://` (people paste `example.com/feed`),
 * - lowercases the scheme + host (case-insensitive per RFC 3986) while leaving
 *   the path untouched (paths are case-sensitive),
 * - drops a trailing slash on an empty path and any fragment.
 *
 * Returns `''` for input that can't be a URL, so callers can reject early.
 */
export function normalizeFeedUrl(input: string): string {
  const trimmed = (input ?? '').trim()
  if (!trimmed) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return ''
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
  // Credentials never belong in a feed URL; rejecting userinfo also turns a
  // pasted `mailto:a@b.com` (which parses as `user@host` once prefixed) into a
  // clean reject rather than a bogus feed.
  if (u.username || u.password) return ''
  u.protocol = u.protocol.toLowerCase()
  u.hostname = u.hostname.toLowerCase()
  u.hash = ''
  let out = u.toString()
  // A bare origin serializes as `https://host/`; keep that, but strip a trailing
  // slash that follows a real path so `/feed` and `/feed/` dedupe together.
  if (u.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** Shape a raw `/api/feeds` row into a {@link Feed}. */
export function shapeFeed(raw: RawFeed): Feed {
  return {
    url: str(raw.url) ?? '',
    title: str(raw.title) ?? '',
    siteUrl: str(raw.siteUrl),
    folder: str(raw.folder),
    iconUrl: str(raw.iconUrl),
    lastFetchedAt: num(raw.lastFetchedAt),
    lastError: str(raw.lastError),
    addedAt: num(raw.addedAt),
  }
}

/**
 * A feed's display label: its title if it has one, else a human-ish version of
 * the URL (host + path) so a just-added, not-yet-refreshed feed still reads well.
 */
export function feedLabel(feed: Feed): string {
  if (feed.title) return feed.title
  try {
    const u = new URL(feed.url)
    return u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return feed.url
  }
}

/** Sort feeds by display label, case-insensitively, for a stable sidebar order. */
/**
 * A single-character badge for a feed's collapsed-rail icon — the first
 * letter/digit of its label, uppercased. Falls back to `•` for a label with no
 * alphanumeric character (e.g. an emoji-only or symbol title).
 */
export function feedInitial(feed: Feed): string {
  const match = feedLabel(feed).match(/[a-z0-9]/i)
  return match ? match[0].toUpperCase() : '•'
}

export function sortFeeds(feeds: Feed[]): Feed[] {
  return [...feeds].sort((a, b) =>
    feedLabel(a).toLocaleLowerCase().localeCompare(feedLabel(b).toLocaleLowerCase()),
  )
}

/**
 * The display label for the feed an item belongs to, looked up by `feedId` —
 * which is the feed's normalized `url` (D8/D12). Returns `null` when no loaded
 * feed matches (an orphaned item whose feed was removed), so a caller can render
 * nothing rather than a blank source label. Used to attribute an item to its
 * feed in mixed views (river/all/folder/starred), where rows come from many feeds.
 */
export function feedTitleFor(feedId: string, feedsByUrl: Map<string, Feed>): string | null {
  const feed = feedsByUrl.get(feedId)
  return feed ? feedLabel(feed) : null
}
