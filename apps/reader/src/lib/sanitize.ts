/**
 * The one place feed HTML is made safe to render.
 *
 * Feed `content`/`summary` is stored **raw** (D10) so the parser stays
 * policy-free and the sanitizer can tighten without re-fetching. Every path that
 * injects feed HTML into the DOM (the reading pane) MUST route through
 * {@link sanitizeHtml} — that is the security boundary against XSS from a
 * hostile feed, not the login gate.
 *
 * Prior art: `apps/handoff/src/lib/markdown.ts` (same DOMPurify dependency).
 */

import DOMPurify from 'dompurify'

/**
 * Force every surviving link to open in a new tab and drop its referrer/opener,
 * so a feed can't navigate the reader away or reach back through `window.opener`.
 * Registered once at module load; DOMPurify hooks are global to the instance.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer nofollow')
  }
})

/**
 * Sanitize a raw feed HTML fragment for safe rendering.
 *
 * DOMPurify drops `<script>`, event-handler attributes (`onclick`, …), and
 * `javascript:` URLs, and — with the config below — also the embedding vectors
 * a reading pane never needs (`<iframe>`, `<object>`, `<form>`, …). What remains
 * is inert markup: text, headings, lists, links, images, code, blockquotes.
 */
export function sanitizeHtml(dirty: string | null | undefined): string {
  if (!dirty) return ''
  return DOMPurify.sanitize(dirty, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['style'],
    // Belt-and-braces: DOMPurify already forbids these, but stating the intent
    // keeps the reading pane's contract explicit for the next reader.
    ALLOW_DATA_ATTR: false,
  })
}

/**
 * Strip a feed fragment down to plain text for a list preview: sanitize first
 * (so we never trust raw HTML), then drop tags and collapse whitespace. Used for
 * the item-row snippet where rendered markup would be noise.
 */
export function htmlToText(dirty: string | null | undefined): string {
  const clean = sanitizeHtml(dirty)
  if (!clean) return ''
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  const text = doc.body.textContent ?? ''
  return text.replace(/\s+/g, ' ').trim()
}
