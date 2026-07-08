/**
 * Pure feed model for the Handoff RSS spine (#188, PRD #185 / ADR-0006).
 *
 * `selectFeedItems` flattens a folder's subtree to its surfacing leaves
 * (files + sites), newest-first, capped at the 50 most recent. `renderFeedXml`
 * emits RSS 2.0 for those items. This module is the reference implementation;
 * the `/feed/*` proxy pipeline embeds a port of the same logic (the platform
 * has no server), kept behaviourally equivalent like the other embedded copies.
 */

import { blobUrl, contentUrl, feedUrl, treeUrl } from './pathUrl'
import { slugifyFilename } from './share'
import type { HandoffNode } from './nodes'

/** The most-recent leaves a feed surfaces. */
export const FEED_ITEM_LIMIT = 50

export interface FeedItem {
  /** Node id — stable `<guid isPermaLink="false">` (a rename does not re-notify). */
  id: string
  type: 'file' | 'site'
  name: string
  /** Verbatim content path — surfaced in the item `<link>`. */
  path: string
  /** ms epoch — the `<pubDate>` (upload time). */
  createdAt: number
  mime: string | null
  size: number | null
  /** Display-title override; null → use `name`. */
  title: string | null
  /** Plain-text note rendered into the item <description>; null → none. */
  description: string | null
}

export interface FeedContext {
  /** Absolute origin for item/enclosure URLs, e.g. `https://handoff.j5s.dev`. */
  origin: string
  /** Channel `<title>`. */
  title: string
  /** Channel `<description>`. */
  description: string
  /** The feed's folder path ('' for the root folder). */
  folderPath: string
  /** Optional ms epoch for `<lastBuildDate>`. */
  buildDate?: number
  /**
   * Share-link token for a private feed (#189 / ADR-0008). When present it is
   * threaded into the self href and every item `<link>`/`<enclosure>` URL so a
   * reader can fetch the feed and its media unauthenticated; absent for a public
   * feed, whose URLs stay tokenless.
   */
  token?: string
}

/**
 * Flatten a folder's subtree nodes to feed items: keep only the leaves
 * (`file`/`site`) that carry a content path, newest-first by `createdAt`, and
 * cap at {@link FEED_ITEM_LIMIT}. Folders are structural and never surface as
 * items; a Site is a single item, never exploded into its internal assets.
 *
 * A leaf whose ancestor chain includes a `feedExcluded` folder (#191 / ADR-0007)
 * is dropped — the flag rides the parentId walk, no extra query and no change to
 * access (an excluded folder stays fully browsable). Excluded folders must be
 * present in `nodes` for the walk to see them.
 *
 * Access filtering and subtree scoping are the caller's job — the `/feed/*`
 * pipeline passes only publicly-viewable subtree leaves.
 */
export function selectFeedItems(nodes: HandoffNode[]): FeedItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const underExcluded = (leaf: HandoffNode): boolean => {
    let cur = byId.get(leaf.parentId)
    let guard = 0
    while (cur && guard < 64) {
      if (cur.feedExcluded === true) return true
      cur = byId.get(cur.parentId)
      guard++
    }
    return false
  }
  return nodes
    .filter((n) => (n.type === 'file' || n.type === 'site') && !!n.path && !underExcluded(n))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, FEED_ITEM_LIMIT)
    .map((n) => ({
      id: n.id,
      type: n.type as 'file' | 'site',
      name: n.name,
      path: n.path as string,
      createdAt: n.createdAt,
      mime: n.mime,
      size: n.size,
      title: n.title,
      description: n.description,
    }))
}

/** XML-escape text content and attribute values. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** RFC 822 / 1123 date string for a `<pubDate>` — what RSS readers expect. */
function rfc822(ms: number): string {
  return new Date(ms).toUTCString()
}

/**
 * HTML-attribute-safe escape for text placed INSIDE a CDATA `<img alt="…">`.
 * Inside CDATA the XML parser does not unescape, but the browser still parses
 * the HTML, so an attribute value's quotes/angle-brackets must be encoded.
 */
function htmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Escape user plain text for an HTML/CDATA feed <description> body and turn
 * newlines into <br>. The caller wraps the result in a <p>.
 */
function descHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n?|\n/g, '<br>')
}

/** Human-readable byte size for a non-image item's `<description>` (''=unknown). */
function humanSize(bytes: number | null): string {
  if (bytes == null || bytes < 0) return ''
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? String(n) : n.toFixed(1)} ${u[i]}`
}

/**
 * A media URL a cross-domain reader can load with NONE of this app's cookies:
 * - a **public** feed serves the bytes directly from the tokenless, cacheable
 *   content endpoint (the "Anyone" ACL passes);
 * - a **private** feed (share-link token present) must use the token-in-URL
 *   `/r/<id>/<slug>?token=` redirect route, since the content endpoint is
 *   cookie/session-gated and takes no token.
 *
 * Either way this is a *stable indirection* — never the (≈5-min) presigned
 * bucket URL — so it re-resolves per fetch and never ships expired.
 */
function mediaUrl(it: FeedItem, ctx: FeedContext): string {
  return ctx.token
    ? `${ctx.origin}/r/${it.id}/${slugifyFilename(it.name)}?token=${ctx.token}`
    : `${ctx.origin}${contentUrl(it.path)}`
}

/**
 * Render RSS 2.0 for the given feed items. A File item carries a `<link>` to its
 * viewer, an `<enclosure>` (mime + length), and — so reader/article views show a
 * body rather than "no content" — a `<description>`: an inline `<img>` (CDATA)
 * plus `<media:content>`/`<media:thumbnail>` for images, a name+size line
 * otherwise. A Site item is a `<link>` with a one-line `<description>`. An empty
 * item list yields a valid empty channel. All text is XML-escaped.
 */
export function renderFeedXml(items: FeedItem[], ctx: FeedContext): string {
  const tokenQs = ctx.token ? `?token=${ctx.token}` : ''
  const channelLink = `${ctx.origin}${treeUrl(ctx.folderPath)}`
  const selfHref = `${ctx.origin}${feedUrl(ctx.folderPath, ctx.token)}`
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">')
  lines.push('<channel>')
  lines.push(`<title>${xmlEscape(ctx.title)}</title>`)
  lines.push(`<link>${xmlEscape(channelLink)}</link>`)
  lines.push(`<description>${xmlEscape(ctx.description)}</description>`)
  lines.push(`<atom:link href="${xmlEscape(selfHref)}" rel="self" type="application/rss+xml"/>`)
  if (ctx.buildDate != null) {
    lines.push(`<lastBuildDate>${rfc822(ctx.buildDate)}</lastBuildDate>`)
  }
  for (const it of items) {
    lines.push('<item>')
    lines.push(`<title>${xmlEscape(it.title || it.name)}</title>`)
    lines.push(`<link>${xmlEscape(ctx.origin + blobUrl(it.path) + tokenQs)}</link>`)
    lines.push(`<guid isPermaLink="false">${xmlEscape(it.id)}</guid>`)
    lines.push(`<pubDate>${rfc822(it.createdAt)}</pubDate>`)
    const note = it.description ? `<p>${descHtml(it.description)}</p>` : ''
    if (it.type === 'file') {
      const media = mediaUrl(it, ctx)
      const mime = it.mime ?? 'application/octet-stream'
      const length = it.size != null && it.size >= 0 ? it.size : 0
      lines.push(`<enclosure url="${xmlEscape(media)}" type="${xmlEscape(mime)}" length="${length}"/>`)
      if (it.mime && it.mime.startsWith('image/')) {
        // Reader/article views render <description>, not <enclosure>; an inline
        // <img> gives them a body + the picture. media:* feeds thumbnail-driven
        // readers (Feedly/Inoreader/NetNewsWire).
        lines.push(`<description><![CDATA[${note}<p><img src="${media}" alt="${htmlAttr(it.name)}" /></p>]]></description>`)
        lines.push(`<media:content url="${xmlEscape(media)}" type="${xmlEscape(mime)}" medium="image"/>`)
        lines.push(`<media:thumbnail url="${xmlEscape(media)}"/>`)
      } else if (note) {
        lines.push(`<description><![CDATA[${note}]]></description>`)
      } else {
        const size = humanSize(it.size)
        lines.push(`<description>${xmlEscape(size ? `${it.name} (${size})` : it.name)}</description>`)
      }
    } else {
      // Site: emit a text/html enclosure so our reader (Rivulet) embeds the site
      // inline — the reader keys embed *detection* on a text/* enclosure on a
      // trusted origin. The mime is only a hint: the reader's consent gate keys on
      // the link ORIGIN, not this label (a feed can't skip consent by lying about
      // the type). The enclosure url is the site's viewer link (what the reader
      // iframes); a served site has no byte length, so 0. The <description> stays
      // so non-embedding readers still show a body.
      lines.push(`<enclosure url="${xmlEscape(ctx.origin + blobUrl(it.path) + tokenQs)}" type="text/html" length="0"/>`)
      if (note) {
        lines.push(`<description><![CDATA[${note}]]></description>`)
      } else {
        lines.push(`<description>${xmlEscape(it.name)}</description>`)
      }
    }
    lines.push('</item>')
  }
  lines.push('</channel>')
  lines.push('</rss>')
  return lines.join('\n')
}
