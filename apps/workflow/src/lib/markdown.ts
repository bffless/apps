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

const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** No scheme (relative/anchor) or an allow-listed one; everything else (`javascript:`, `data:`, …) is unsafe. */
function isSafeHref(href: string): boolean {
  const trimmed = href.trim()
  if (SAFE_SCHEME.test(trimmed)) return true
  if (/^[#/.]/.test(trimmed)) return true
  return !HAS_SCHEME.test(trimmed)
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
      let out = `<a href="${href}"`
      if (title) out += ` title="${escapeHtml(title)}"`
      out += `>${text}</a>`
      return out
    },
  },
})

export function renderMarkdown(source: string): string {
  return instance.parse(source, { async: false })
}
