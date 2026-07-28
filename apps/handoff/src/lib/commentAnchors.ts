/**
 * Text-anchor engine for viewer margin comments (spec §4).
 *
 * Anchors are W3C-Web-Annotation-style: exact quote + ≤32 chars of context +
 * character offsets into the document's concatenated text. `resolveTextAnchor`
 * is pure string logic (unit-hard); the TextIndex maps offsets ↔ DOM so the
 * bridge can build Ranges for highlighting. Resolution is read-only — stored
 * anchors are never rewritten (re-uploading old content restores its anchors).
 */
import type { CommentAnchorText } from './comments'

export const CONTEXT_CHARS = 32

export interface TextIndex {
  /** Concatenated data of every text node under the root, in document order. */
  text: string
  nodes: Text[]
  /** nodeStarts[i] = offset of nodes[i]'s first character within `text`. */
  nodeStarts: number[]
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'])

export function buildTextIndex(root: Node): TextIndex {
  const nodes: Text[] = []
  const nodeStarts: number[] = []
  let text = ''
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && SKIP_TAGS.has(n.parentElement.tagName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text)
    nodeStarts.push(text.length)
    text += (n as Text).data
  }
  return { text, nodes, nodeStarts }
}

/** Map a text offset to (text node, in-node offset). Binary search over nodeStarts. */
function domPosition(index: TextIndex, pos: number): { node: Text; offset: number } | null {
  const { nodes, nodeStarts } = index
  if (!nodes.length || pos < 0 || pos > index.text.length) return null
  let lo = 0, hi = nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (nodeStarts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  const offset = Math.min(pos - nodeStarts[lo], nodes[lo].data.length)
  return { node: nodes[lo], offset }
}

export function anchorFromRange(index: TextIndex, range: Range): CommentAnchorText | null {
  if (range.collapsed) return null
  // Offset of a boundary = start of its text node + boundary offset; for
  // element boundaries, walk to the nearest text position by comparing with
  // each node via range comparison (keep it simple: build a probe range).
  const start = textOffsetOf(index, range.startContainer, range.startOffset)
  const end = textOffsetOf(index, range.endContainer, range.endOffset)
  if (start == null || end == null || end <= start) return null
  const quote = index.text.slice(start, end)
  if (!quote.trim()) return null
  return {
    type: 'text',
    quote,
    prefix: index.text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: index.text.slice(end, end + CONTEXT_CHARS),
    start,
    end,
  }
}

function textOffsetOf(index: TextIndex, container: Node, offset: number): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const i = index.nodes.indexOf(container as Text)
    if (i < 0) return null
    return index.nodeStarts[i] + Math.min(offset, (container as Text).data.length)
  }
  // Element container: the boundary sits before `container.childNodes[offset]`.
  // Find the first indexed text node at/after that point in document order.
  const doc = container.ownerDocument!
  const probe = doc.createRange()
  probe.setStart(container, offset)
  for (let i = 0; i < index.nodes.length; i++) {
    const r = doc.createRange()
    r.selectNodeContents(index.nodes[i])
    if (probe.compareBoundaryPoints(Range.START_TO_START, r) <= 0) return index.nodeStarts[i]
  }
  return index.text.length
}

export function rangeFromSpan(
  index: TextIndex, start: number, end: number, doc: Document,
): Range | null {
  const s = domPosition(index, start)
  const e = domPosition(index, end)
  if (!s || !e) return null
  const range = doc.createRange()
  range.setStart(s.node, s.offset)
  range.setEnd(e.node, e.offset)
  return range
}

/** Score an exact-quote occurrence: context agreement, then distance from the stored start. */
function scoreOccurrence(text: string, at: number, a: CommentAnchorText): number {
  const pre = text.slice(Math.max(0, at - a.prefix.length), at)
  const suf = text.slice(at + a.quote.length, at + a.quote.length + a.suffix.length)
  let score = 0
  if (a.prefix && pre === a.prefix) score += 2
  if (a.suffix && suf === a.suffix) score += 2
  return score
}

export function resolveTextAnchor(
  text: string, anchor: CommentAnchorText,
): { start: number; end: number } | null {
  if (!anchor.quote) return null

  // Pass 1: exact occurrences, best context score, nearest to stored start.
  const hits: number[] = []
  for (let at = text.indexOf(anchor.quote); at >= 0; at = text.indexOf(anchor.quote, at + 1)) {
    hits.push(at)
    if (hits.length > 200) break // pathological duplication — bail to nearest
  }
  if (hits.length) {
    let best = hits[0], bestScore = -Infinity
    for (const at of hits) {
      const s = scoreOccurrence(text, at, anchor) * 1_000_000 - Math.abs(at - anchor.start)
      if (s > bestScore) { bestScore = s; best = at }
    }
    return { start: best, end: best + anchor.quote.length }
  }

  // Pass 2: whitespace-normalized fuzzy match. Build a normalized copy of the
  // document text with an offset map back to raw positions, then search for the
  // normalized quote in it.
  const rawToNorm: number[] = []
  let norm = ''
  let lastWasSpace = true
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (!lastWasSpace) { rawToNorm.push(i); norm += ' '; lastWasSpace = true }
    } else {
      rawToNorm.push(i); norm += ch; lastWasSpace = false
    }
  }
  const normQuote = anchor.quote.replace(/\s+/g, ' ').trim()
  if (!normQuote) return null
  const at = norm.indexOf(normQuote)
  if (at < 0) return null
  const rawStart = rawToNorm[at]
  const lastIdx = at + normQuote.length - 1
  const rawEnd = rawToNorm[lastIdx] + 1
  return { start: rawStart, end: rawEnd }
}
