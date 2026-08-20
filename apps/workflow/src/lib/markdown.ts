/**
 * The one seam that turns markdown into an HTML string safe for
 * `dangerouslySetInnerHTML` (values/MarkdownView, the only consumer). 05:
 * "Summaries are markdown; HTML is not interpreted" — so raw HTML in the
 * source is escaped to text rather than injected, and unsafe link and image
 * urls (`javascript:`, `vbscript:`, …) never reach an `href`/`src` — the
 * allow-list itself lives in `lib/url` (`isSafeUrl`), shared with FileCard.
 *
 * A dedicated `Marked` instance (not the global `marked` singleton) so this
 * config can't leak into, or be leaked into by, anything else importing
 * `marked`.
 */
import { Marked } from 'marked'
import type { Tokens } from 'marked'
import { isSafeUrl, normalizeForSchemeCheck } from './url'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
      if (!isSafeUrl(href)) return text
      const attr = safeHrefAttr(href)
      if (attr === null) return text
      let out = `<a href="${attr}"`
      if (title) out += ` title="${escapeHtml(title)}"`
      out += `>${text}</a>`
      return out
    },
    /**
     * marked's default `image` renderer runs the alt tokens through its
     * `TextRenderer`, whose `text()` hands back the raw string — so
     * `![" onerror="alert(1)](x.png)` ships an `onerror` attribute straight
     * into the summary. The alt is escaped from the token's raw `text` here
     * (never re-parsed), and the src goes through the same allow-list a link
     * href does: an image is a fetch the browser makes unprompted.
     */
    image({ href, title, text }: Tokens.Image) {
      const alt = escapeHtml(text)
      if (!isSafeUrl(href)) return alt
      const attr = safeHrefAttr(href)
      if (attr === null) return alt
      let out = `<img src="${attr}" alt="${alt}"`
      if (title) out += ` title="${escapeHtml(title)}"`
      out += '>'
      return out
    },
  },
})

export function renderMarkdown(source: string): string {
  return instance.parse(source, { async: false })
}
