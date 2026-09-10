/**
 * The one-line description a **collapsed** value shows beside its name (the
 * 2026-09-09 UX review: "if I want to get to the next input, I have to scroll
 * like a frickin' mile"). Every value in a pane is now a disclosure, so the
 * closed row has to say enough that a person can pick the one they want
 * without opening any of them — `application/zip · 131.1 MB`, `8,681 items`,
 * `9 keys`, or the scalar itself.
 *
 * Its own plain `.ts` module for the reason `valueMeta` and `inferDecl` are:
 * the same value collapsed on two screens must read the same on both, and a
 * component file cannot export a non-component (react-refresh).
 */
import { isFileRefLike } from '../../lib/runner/fileRef'
import { formatNumber, humanSize } from './shape'
import type { ValueDecl } from '../../lib/valueDecl'

/** How much of a string a closed row shows before the ellipsis takes over. */
const PREVIEW = 80

/** A file ref's own summary: its type and, when it has one, its size. */
function fileSummary(value: { contentType?: unknown; size?: unknown }): string {
  const parts: string[] = []
  if (typeof value.contentType === 'string' && value.contentType) parts.push(value.contentType)
  if (typeof value.size === 'number' && value.size > 0) parts.push(humanSize(value.size))
  return parts.join(' · ')
}

/**
 * `undefined` when there is nothing worth saying — the caller then shows the
 * name and the type tag alone rather than an empty gap.
 */
export function valueSummary(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined

  if (isFileRefLike(value)) return fileSummary(value) || undefined

  if (Array.isArray(value)) {
    // A list of files says how many files, not how many items.
    const files = value.length > 0 && value.every((item) => isFileRefLike(item))
    return `${formatNumber(value.length)} ${files ? 'file' : 'item'}${value.length === 1 ? '' : 's'}`
  }

  // Deliberately not `shape.isScalar`: that one means "would fit in a table
  // cell" and so rejects any string with a newline — exactly the strings that
  // most need a one-line preview here.
  if (typeof value === 'string') {
    // Prose, on one line: newlines and runs of spaces collapse, and anything
    // past `PREVIEW` is cut here rather than left to the ellipsis alone — a
    // whole markdown document in the DOM of a closed row helps nobody.
    const text = value.replace(/\s+/g, ' ').trim()
    if (!text) return undefined
    return text.length > PREVIEW ? `${text.slice(0, PREVIEW)}…` : text
  }

  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (typeof value === 'object') {
    const keys = Object.keys(value as object).length
    return `${formatNumber(keys)} key${keys === 1 ? '' : 's'}`
  }

  return undefined
}

/** Renderers that always draw something substantial enough to be worth folding. */
const BULKY_RENDERERS = new Set(['transcript', 'images', 'chart', 'code'])
const BULKY_TYPES = new Set(['table', 'markdown'])

/**
 * Whether a value has enough body to be worth a disclosure.
 *
 * A short scalar does not: `valueSummary` already prints the whole of it on
 * the closed row, so folding it would show the same text twice — once in the
 * row, once in the body — and ask for a click to reveal nothing new. Those
 * values stay inline however the pane asked, which is also the better read:
 * a form step's `title` is one line, and one line is not a list item.
 */
export function isBulky(decl: ValueDecl, value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (decl.list === true) return true
  if (typeof decl.render === 'string' && BULKY_RENDERERS.has(decl.render)) return true
  if (BULKY_TYPES.has(decl.type ?? '')) return true
  if (isFileRefLike(value)) return true
  if (Array.isArray(value)) return true
  // A string earns a fold once it stops being a one-liner.
  if (typeof value === 'string') return value.length > PREVIEW || value.includes('\n')
  if (typeof value === 'number' || typeof value === 'boolean') return false
  return typeof value === 'object'
}
