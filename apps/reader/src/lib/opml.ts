/**
 * OPML import / export — pure, browser-side (native `DOMParser`), so it's the
 * tested seam for story #117. No new backend: import parses an `.opml` file into
 * `{ url, title, folder }` triples that the add-feed flow upserts (dedup by url,
 * see `api.addFeed`), and export serializes the current feed list back to OPML.
 *
 * Feed identity is the normalized url (shared with `lib/feeds`), so an OPML round
 * trip — export then re-import — dedupes against what you already follow instead
 * of double-subscribing.
 */

import { feedLabel, normalizeFeedUrl, type Feed } from './feeds'
import { groupFeedsByFolder } from './folders'

/** A subscription as it appears in OPML: url is the identity, folder null = top level. */
export type OpmlFeed = { url: string; title: string; folder: string | null }

/** Read an attribute, trimmed; XML attribute names are case-sensitive (`xmlUrl`). */
function attr(el: Element, name: string): string {
  const v = el.getAttribute(name)
  return v ? v.trim() : ''
}

/** An outline's label: OPML's optional `title`, else the required `text`, else ''. */
function label(el: Element): string {
  return attr(el, 'title') || attr(el, 'text')
}

/**
 * Parse OPML text into subscriptions. Any `<outline>` with an `xmlUrl` is a feed;
 * an outline without one is a folder whose label scopes the feeds nested under it
 * (deepest-wins for the rare nested-folder case). Urls are normalized and deduped
 * (first outline wins) so a messy export collapses to clean subscriptions.
 *
 * Returns `[]` for malformed XML or input with no feeds — the caller surfaces
 * "no feeds found" rather than a parse crash.
 */
export function parseOpml(xml: string): OpmlFeed[] {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml ?? '', 'text/xml')
  } catch {
    return []
  }
  if (doc.getElementsByTagName('parsererror').length > 0) return []
  const body = doc.getElementsByTagName('body')[0]
  if (!body) return []

  const out: OpmlFeed[] = []
  const seen = new Set<string>()
  const visit = (parent: Element, folder: string | null) => {
    for (const child of Array.from(parent.children)) {
      if (child.tagName.toLowerCase() !== 'outline') continue
      const rawUrl = attr(child, 'xmlUrl')
      if (rawUrl) {
        const url = normalizeFeedUrl(rawUrl)
        if (url && !seen.has(url)) {
          seen.add(url)
          out.push({ url, title: label(child), folder })
        }
        // A feed outline may (rarely) nest others; don't treat it as a folder.
      } else {
        visit(child, label(child) || folder)
      }
    }
  }
  visit(body, null)
  return out
}

/** Escape the five XML-significant characters for use in text or attribute values. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** One `<outline>` line for a feed. `feedLabel` gives an untitled feed a readable label. */
function feedOutline(feed: Feed): string {
  const t = esc(feedLabel(feed))
  const html = feed.siteUrl ? ` htmlUrl="${esc(feed.siteUrl)}"` : ''
  return `<outline type="rss" text="${t}" title="${t}" xmlUrl="${esc(feed.url)}"${html}/>`
}

/**
 * Serialize feeds to OPML 2.0, grouping by folder (named folders first, then
 * uncategorized — the `lib/folders` grouping the sidebar uses). The result
 * round-trips through {@link parseOpml}, which is the practical test of "valid
 * OPML another reader can import."
 */
export function generateOpml(feeds: Feed[], title = 'Rivulet subscriptions'): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${esc(title)}</title>`,
    '  </head>',
    '  <body>',
  ]
  for (const group of groupFeedsByFolder(feeds)) {
    if (group.folder != null) {
      lines.push(`    <outline text="${esc(group.folder)}" title="${esc(group.folder)}">`)
      for (const feed of group.feeds) lines.push(`      ${feedOutline(feed)}`)
      lines.push('    </outline>')
    } else {
      for (const feed of group.feeds) lines.push(`    ${feedOutline(feed)}`)
    }
  }
  lines.push('  </body>', '</opml>')
  return lines.join('\n') + '\n'
}
