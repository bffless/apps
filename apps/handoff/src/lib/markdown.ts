import { marked } from 'marked'
import DOMPurify from 'dompurify'

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
 * Build the full HTML document for the viewer's Markdown iframe.
 *
 * `bodyHtml` is the already-sanitized rendered Markdown (from `renderMarkdown`);
 * `base` is the viewer base (`viewerBase(node)`) injected as `<base href>` so a
 * relative reference like `assets/logo.png` resolves against the file's own
 * Folder on the content endpoint — with no rewriting of the stored Markdown.
 * When `base` is null (no known folder), the `<base>` tag is omitted.
 */
export function markdownDocument(bodyHtml: string, base: string | null): string {
  const baseTag = base ? `<base href="${base}">` : ''
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    baseTag +
    `<style>${MARKDOWN_IFRAME_CSS}</style></head>` +
    `<body><div class="markdown-body">${bodyHtml}</div></body></html>`
  )
}
