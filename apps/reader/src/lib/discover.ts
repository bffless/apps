/**
 * Feed auto-discovery — pure, browser-side (native `DOMParser`), so it's the
 * tested seam for story #113. Paste a site homepage URL and Rivulet finds its
 * feed; paste a feed URL and it's added directly.
 *
 * The network hop (fetching cross-origin HTML through the `/api/discover`
 * `http_request` proxy, dodging CORS — see CONTEXT D12) is injected as a
 * `PageFetcher`, so every decision here — "is this already a feed?", "which
 * alternate link?", "which common path?" — is exercised without a real fetch.
 * `lib/api` wires the real proxy-backed fetcher.
 */

import { normalizeFeedUrl } from './feeds'

/** A feed found for a pasted URL. `url` is normalized (the add-feed identity). */
export type DiscoveredFeed = { url: string; title: string }

/** One fetched page, as the injected {@link PageFetcher} returns it. */
export type FetchedPage = {
  /** The URL that was fetched (the base for resolving relative alternate links). */
  url: string
  /** The response body, as text. */
  body: string
  /** The upstream `Content-Type`, if the proxy surfaced it. */
  contentType: string | null
  /** Whether the fetch returned a 2xx status. */
  ok: boolean
}

/** Fetches a URL's body for discovery — real impl proxies through `/api/discover`. */
export type PageFetcher = (url: string) => Promise<FetchedPage>

/** `<link>` types that denote a subscribable feed. */
const FEED_LINK_TYPES = new Set([
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
  'application/feed+json',
  'application/json',
])

/** The well-known paths to probe when a page advertises no alternate link. */
const COMMON_PATHS = ['/feed', '/rss', '/atom.xml', '/feed.xml']

/**
 * Is this fetched body itself a feed (rather than an HTML landing page)? Used to
 * short-circuit discovery when the pasted URL is already a feed, and to confirm
 * a common-path probe actually hit one.
 *
 * A feed content-type is trusted outright; otherwise the body is sniffed for a
 * feed root element (RSS/Atom/RDF) past any BOM, XML declaration or comment, or
 * for a JSON Feed's `version` marker.
 */
export function isFeedContent(body: string, contentType: string | null): boolean {
  if (contentType && /(rss|atom|rdf|feed)\+(xml|json)/i.test(contentType)) return true

  const text = (body ?? '').replace(/^\uFEFF/, '').trimStart()
  if (!text) return false

  // Peek at the leading markup, skipping the XML declaration and any comments so
  // the real root element is what we test.
  const head = text
    .replace(/^<\?xml[^>]*\?>/i, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trimStart()
  if (/^<(rss|feed|rdf:RDF|rdf\b)/i.test(head)) return true

  // JSON Feed: an object whose version points at jsonfeed.org.
  if (head.startsWith('{') && /"version"\s*:\s*"https?:\/\/jsonfeed\.org/i.test(head)) return true

  return false
}

/**
 * Extract feed URLs advertised by a page's `<link rel="alternate">` tags, in
 * document order, resolved absolute against `baseUrl` and normalized. Only
 * recognized feed `type`s are kept; duplicate hrefs collapse (first wins).
 */
export function parseFeedLinks(html: string, baseUrl: string): DiscoveredFeed[] {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html ?? '', 'text/html')
  } catch {
    return []
  }

  const out: DiscoveredFeed[] = []
  const seen = new Set<string>()
  for (const link of Array.from(doc.querySelectorAll('link[rel~="alternate"][href]'))) {
    const type = (link.getAttribute('type') ?? '').trim().toLowerCase()
    if (!FEED_LINK_TYPES.has(type)) continue
    const href = (link.getAttribute('href') ?? '').trim()
    if (!href) continue
    let abs: string
    try {
      abs = normalizeFeedUrl(new URL(href, baseUrl).toString())
    } catch {
      continue
    }
    if (!abs || seen.has(abs)) continue
    seen.add(abs)
    out.push({ url: abs, title: (link.getAttribute('title') ?? '').trim() })
  }
  return out
}

/**
 * The well-known feed URLs to probe for a site, built from the pasted URL's
 * origin (so `example.com/blog/post` still probes `example.com/feed`, …).
 */
export function commonFeedPaths(siteUrl: string): string[] {
  let origin: string
  try {
    origin = new URL(siteUrl).origin
  } catch {
    return []
  }
  return COMMON_PATHS.map((p) => origin + p)
}

/**
 * Resolve a pasted URL — a homepage or a feed — to a subscribable feed URL,
 * fetching pages through the injected {@link PageFetcher}:
 *
 *  1. if the pasted URL is already a feed, add it directly (no discovery);
 *  2. else read the page's `<link rel="alternate">` feed link;
 *  3. else probe the {@link commonFeedPaths} in order, returning the first hit.
 *
 * Throws before any fetch on an unusable URL, and after probing if nothing looks
 * like a feed — the caller surfaces the message.
 */
export async function resolveFeedUrl(input: string, fetchPage: PageFetcher): Promise<DiscoveredFeed> {
  const start = normalizeFeedUrl(input)
  if (!start) throw new Error('Enter a valid site or feed URL')

  const page = await fetchPage(start)

  // 1. Already a feed → add directly, skipping discovery entirely.
  if (isFeedContent(page.body, page.contentType)) return { url: start, title: '' }

  // 2. Alternate link in the page's HTML.
  const links = parseFeedLinks(page.body, page.url || start)
  if (links.length > 0) return links[0]

  // 3. Common-path fallback: first path whose content is actually a feed wins.
  for (const candidate of commonFeedPaths(start)) {
    let probe: FetchedPage
    try {
      probe = await fetchPage(candidate)
    } catch {
      continue // a dead path shouldn't abort the sweep
    }
    if (isFeedContent(probe.body, probe.contentType)) {
      return { url: normalizeFeedUrl(candidate), title: '' }
    }
  }

  throw new Error('No feed found for that site')
}
