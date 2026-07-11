import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { CONTENT_PREFIX } from './contentPath'

marked.use({ gfm: true })

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md) as string
  return DOMPurify.sanitize(raw)
}

/**
 * Self-contained `.markdown-body` styling for the viewer iframe. The iframe is a
 * separate document, so the app's token-based CSS (which relies on `:root` CSS
 * vars) is inlined here with concrete values — mirroring src/index.css's
 * `.markdown-body` rules so rendered docs keep their look inside the frame.
 */
export const MARKDOWN_IFRAME_CSS = `
  html { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.65;
    color: #1e2027;
    background: transparent;
  }
  .markdown-body { max-width: 48rem; margin: 0 auto; padding: 2rem 1rem; }
  .markdown-body h1, .markdown-body h2, .markdown-body h3 {
    font-weight: 600; line-height: 1.25; margin: 1.4em 0 0.5em; text-wrap: balance;
  }
  .markdown-body h1 { font-size: 1.6rem; }
  .markdown-body h2 { font-size: 1.3rem; }
  .markdown-body h3 { font-size: 1.1rem; }
  .markdown-body p, .markdown-body ul, .markdown-body ol { margin: 0.75em 0; }
  .markdown-body ul, .markdown-body ol { padding-left: 1.5em; }
  .markdown-body ul { list-style: disc; }
  .markdown-body ol { list-style: decimal; }
  .markdown-body a { color: #2563eb; text-decoration: underline; }
  .markdown-body code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.875em;
    background: rgba(127,127,127,0.14); padding: 0.15em 0.35em; border-radius: 4px;
  }
  .markdown-body pre {
    background: rgba(127,127,127,0.14); padding: 1em; border-radius: 8px; overflow: auto;
  }
  .markdown-body pre code { background: none; padding: 0; }
  .markdown-body blockquote {
    border-left: 3px solid rgba(127,127,127,0.4); padding-left: 1em; color: #6b7280; margin: 0.75em 0;
  }
  .markdown-body img { max-width: 100%; border-radius: 8px; }
  .markdown-body table { border-collapse: collapse; }
  .markdown-body th, .markdown-body td { border: 1px solid rgba(127,127,127,0.3); padding: 0.4em 0.6em; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e7ea; }
    .markdown-body a { color: #60a5fa; }
    .markdown-body blockquote { color: #9ca3af; }
  }
`

/**
 * Embed-mode override: when the viewer is iframed inline by another app
 * (`?embed=1`), the embedder owns the reading measure and horizontal padding, so
 * the content must fill the frame instead of imposing Handoff's own 48rem
 * column. Without this the embedded body sits visibly narrower and offset from
 * the host's normal article width. Vertical padding is kept for breathing room.
 */
const MARKDOWN_EMBED_CSS = `
  .markdown-body { max-width: none; margin: 0; padding: 1rem 0 2rem; }
`

/**
 * Retarget the anchors of a rendered Markdown document for iframe display.
 *
 * The doc renders in a same-origin iframe whose `<base href>` is the file's own
 * Folder on the content endpoint, so by default EVERY link navigates the frame:
 * an external link loads a site that (like github.com) usually refuses to be
 * framed, and a relative link to a sibling doc resolves to the raw content URL,
 * which the browser downloads instead of rendering. Both are fixed here rather
 * than by rewriting the stored Markdown.
 *
 * Runs on the already-sanitized HTML (after DOMPurify), so it cannot reintroduce
 * anything sanitization stripped, and DOMPurify's attribute allow-list cannot
 * strip the `target`/`rel` added here.
 *
 * `embed` (the doc is inside a HOST app's iframe) turns the top-window target
 * into a new tab: `_top` would navigate the *host* away, which is worse than the
 * bug being fixed.
 */
export function retargetLinks(
  bodyHtml: string,
  base: string | null,
  { embed = false }: { embed?: boolean } = {},
): string {
  const origin = window.location.origin
  const baseUrl = new URL(base ?? '/', origin)
  const topTarget = embed ? '_blank' : '_top'

  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')

  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) continue // in-document anchor — scroll the frame

    let resolved: URL
    try {
      resolved = new URL(href, baseUrl)
    } catch {
      continue // unparseable — leave exactly as authored
    }
    // mailto:, tel:, … — the browser hands these off without navigating the frame.
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue

    if (resolved.origin !== origin) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
      continue
    }

    // Same origin: a content-endpoint link is a Handoff node — send it to that
    // node's viewer page instead of its raw bytes. The two URLs differ only by
    // prefix, so the per-segment encoding carries over untouched.
    if (resolved.pathname.startsWith(CONTENT_PREFIX)) {
      const rest = resolved.pathname.slice(CONTENT_PREFIX.length)
      a.setAttribute('href', `/blob/${rest}${resolved.search}${resolved.hash}`)
    }
    a.setAttribute('target', topTarget)
    if (topTarget === '_blank') a.setAttribute('rel', 'noopener noreferrer')
  }

  return doc.body.innerHTML
}

/**
 * Build the full HTML document for the viewer's Markdown iframe.
 *
 * `bodyHtml` is the already-sanitized rendered Markdown (from `renderMarkdown`);
 * `base` is the viewer base (`viewerBase(node)`) injected as `<base href>` so a
 * relative reference like `assets/logo.png` resolves against the file's own
 * Folder on the content endpoint — with no rewriting of the stored Markdown.
 * When `base` is null (no known folder), the `<base>` tag is omitted.
 *
 * Anchors are retargeted by `retargetLinks` so they escape the frame correctly:
 * an external link opens in a new tab, and a link to a sibling file opens that
 * file's `/blob/` viewer page instead of downloading its bytes.
 *
 * `embed` lifts Handoff's own reading measure so the host app (e.g. the RSS
 * reader) can align the rendered body with its own article width, and keeps
 * internal links off `_top` so they can never navigate that host away.
 */
export function markdownDocument(
  bodyHtml: string,
  base: string | null,
  { embed = false }: { embed?: boolean } = {},
): string {
  const baseTag = base ? `<base href="${base}">` : ''
  const css = embed ? MARKDOWN_IFRAME_CSS + MARKDOWN_EMBED_CSS : MARKDOWN_IFRAME_CSS
  const body = retargetLinks(bodyHtml, base, { embed })
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    baseTag +
    `<style>${css}</style></head>` +
    `<body><div class="markdown-body">${body}</div></body></html>`
  )
}
