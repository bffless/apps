/**
 * Item domain types + pure shaping.
 *
 * An **item** is a single feed entry, deduped by `guid` (D4/D8). The server
 * stores content **raw**; nothing here sanitizes — rendering does, at the seam
 * (`sanitizeHtml`). This module only normalizes the loosely-typed `/api/items`
 * row into a predictable {@link Item} and derives display-only bits (preview
 * text, a sortable timestamp). Read/star/river logic lands in later stories
 * (#114/#115); keeping shaping isolated lets those build on a stable type.
 */

import { htmlToText } from './sanitize'

export type Item = {
  guid: string
  feedId: string
  title: string
  link: string | null
  author: string | null
  /** Original ISO/string timestamp from the feed, as stored. */
  publishedAt: string | null
  summary: string | null
  content: string | null
  /** Primary enclosure mime carried from the feed, used for embed detection (e.g. `text/markdown` for a Handoff post). */
  enclosureType: string | null
  read: boolean
  starred: boolean
  archived: boolean
  fetchedAt: number | null
}

export type RawItem = Record<string, unknown>

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

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1'
}

/** Shape a raw `/api/items` row into an {@link Item}. */
export function shapeItem(raw: RawItem): Item {
  return {
    guid: str(raw.guid) ?? '',
    feedId: str(raw.feedId) ?? '',
    title: str(raw.title) ?? '',
    link: str(raw.link),
    author: str(raw.author),
    publishedAt: str(raw.publishedAt),
    summary: str(raw.summary),
    content: str(raw.content),
    enclosureType: str(raw.enclosureType),
    read: bool(raw.read),
    starred: bool(raw.starred),
    archived: bool(raw.archived),
    fetchedAt: num(raw.fetchedAt),
  }
}

/**
 * A millisecond timestamp for ordering, from `publishedAt` when parseable, else
 * `fetchedAt`, else `0`. Feeds carry wildly varied date formats; `Date.parse`
 * handles RFC-822 and ISO-8601 (the two `xml_feed_parse` emits) and we fall
 * back rather than throw so one unparseable date can't break a sort.
 */
export function itemTimestamp(item: Item): number {
  if (item.publishedAt) {
    const t = Date.parse(item.publishedAt)
    if (!Number.isNaN(t)) return t
  }
  return item.fetchedAt ?? 0
}

/**
 * A short plain-text snippet for an item row: prefers `summary`, falls back to
 * `content` (truncated feeds may carry only one), flattened and clipped. Never
 * emits HTML — it routes through the sanitizer first.
 */
export function itemPreview(item: Item, maxLen = 200): string {
  const text = htmlToText(item.summary ?? item.content)
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen).trimEnd() + '…'
}

/**
 * The HTML a reading pane should render for an item: full `content`, falling
 * back to `summary` for truncated feeds. **Still raw** — the caller sanitizes.
 */
export function itemBodyHtml(item: Item): string {
  return item.content ?? item.summary ?? ''
}
