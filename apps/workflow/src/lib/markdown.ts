/**
 * The one seam that turns markdown into an HTML string safe for
 * `dangerouslySetInnerHTML` (values/MarkdownView, the only consumer). 05:
 * "Summaries are markdown; HTML is not interpreted" — so raw HTML in the
 * source is escaped to text rather than injected, and unsafe link protocols
 * (`javascript:`, `vbscript:`, …) never reach an `href`.
 *
 * A dedicated `Marked` instance (not the global `marked` singleton) so this
 * config can't leak into, or be leaked into by, anything else importing
 * `marked`.
 */
import { Marked } from 'marked'
import type { Tokens } from 'marked'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * WHATWG URL parsing strips ASCII tab/newline/CR from anywhere in the string
 * (not just the ends) before a scheme is ever read — `java\tscript:` parses
 * as `javascript:`. Also trims the usual leading/trailing whitespace/control
 * characters, so both are gone before the scheme allow-list check below.
 */
function normalizeForSchemeCheck(href: string): string {
  let out = ''
  for (let i = 0; i < href.length; i++) {
    const code = href.charCodeAt(i)
    if (code > 32) out += href[i]
  }
  return out
}

// An HTML entity (numeric or named, e.g. `&#58;`, `&#x3a;`, `&colon;`) inside
// an href can decode to a colon *after* this string is written into the DOM,
// smuggling a `javascript:` scheme past a check that only ever sees the raw,
// still-encoded token text. `&amp;` is excluded — it's the ordinary way to
// write a literal `&` in a query string and decodes to nothing dangerous.
const SUSPICIOUS_ENTITY = /&(?!amp;)(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i

const SAFE_SCHEME = /^(https?:|mailto:)/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Allow-list: `http:`/`https:`/`mailto:`, and anything with no scheme at all
 * (relative, root-relative, or a `#fragment`). Everything else — including
 * any href that carries an HTML entity — is unsafe; the caller falls back to
 * rendering the link text with no `<a>` at all.
 */
function isSafeHref(rawHref: string): boolean {
  if (SUSPICIOUS_ENTITY.test(rawHref)) return false
  const href = normalizeForSchemeCheck(rawHref)
  if (SAFE_SCHEME.test(href)) return true
  if (/^[#/.]/.test(href)) return true
  return !HAS_SCHEME.test(href)
}

/**
 * marked's own renderer runs a href through `cleanUrl` (not exported) before
 * interpolating it; this override replaces marked's `link` renderer entirely
 * rather than extending it, so it needs the same step. `encodeURI`
 * percent-encodes `"`, `<`, `>`, space, etc. so the href can't break out of
 * the `href="…"` attribute it's written into; `escapeHtml` on top catches
 * the handful of characters (`&`, `'`) `encodeURI` leaves alone.
 */
function safeHrefAttr(rawHref: string): string | null {
  try {
    const cleaned = encodeURI(normalizeForSchemeCheck(rawHref)).replace(/%25/g, '%')
    return escapeHtml(cleaned)
  } catch {
    return null
  }
}

const instance = new Marked({
  renderer: {
    // marked v16 tokenizes both block html (`Tokens.HTML`) and inline html
    // (`Tokens.Tag`) as `type: 'html'`, and both dispatch through this one
    // renderer method — overriding it escapes both instead of injecting them.
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text)
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens)
      if (!isSafeHref(href)) return text
      const attr = safeHrefAttr(href)
      if (attr === null) return text
      let out = `<a href="${attr}"`
      if (title) out += ` title="${escapeHtml(title)}"`
      out += `>${text}</a>`
      return out
    },
  },
})

export function renderMarkdown(source: string): string {
  return instance.parse(source, { async: false })
}
