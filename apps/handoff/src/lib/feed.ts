/**
 * Pure feed model for the Handoff RSS spine (#188, PRD #185 / ADR-0006).
 *
 * `selectFeedItems` flattens a folder's subtree to its surfacing leaves
 * (files + sites), newest-first, capped at the 50 most recent. `renderFeedXml`
 * emits RSS 2.0 for those items. This module is the reference implementation;
 * the `/feed/*` proxy pipeline embeds a port of the same logic (the platform
 * has no server), kept behaviourally equivalent like the other embedded copies.
 */

import { blobUrl, feedUrl, treeUrl } from './pathUrl'
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
 * Render RSS 2.0 for the given feed items. A File item carries a `<link>` to
 * its viewer and an `<enclosure>` (mime + length) so readers preview inline; a
 * Site item is a single `<link>` only. An empty item list yields a valid empty
 * channel. All text is XML-escaped.
 */
export function renderFeedXml(items: FeedItem[], ctx: FeedContext): string {
  const tokenQs = ctx.token ? `?token=${ctx.token}` : ''
  const channelLink = `${ctx.origin}${treeUrl(ctx.folderPath)}`
  const selfHref = `${ctx.origin}${feedUrl(ctx.folderPath, ctx.token)}`
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">')
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
    lines.push(`<title>${xmlEscape(it.name)}</title>`)
    lines.push(`<link>${xmlEscape(ctx.origin + blobUrl(it.path) + tokenQs)}</link>`)
    lines.push(`<guid isPermaLink="false">${xmlEscape(it.id)}</guid>`)
    lines.push(`<pubDate>${rfc822(it.createdAt)}</pubDate>`)
    if (it.type === 'file') {
      const encUrl = `${ctx.origin}/r/${it.id}/${slugifyFilename(it.name)}${tokenQs}`
      const mime = it.mime ?? 'application/octet-stream'
      const length = it.size != null && it.size >= 0 ? it.size : 0
      lines.push(`<enclosure url="${xmlEscape(encUrl)}" type="${xmlEscape(mime)}" length="${length}"/>`)
    }
    lines.push('</item>')
  }
  lines.push('</channel>')
  lines.push('</rss>')
  return lines.join('\n')
}
