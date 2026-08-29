/**
 * The `markdown` type's default viewer (02) and the ONLY component allowed
 * to use `dangerouslySetInnerHTML` — and only with `renderMarkdown()` output,
 * which escapes raw HTML rather than interpreting it (05).
 */
import type { ImageMap } from '../../lib/imageMap'
import { renderMarkdown } from '../../lib/markdown'

export function MarkdownView({ value, images }: { value: string; images?: ImageMap }) {
  const html = renderMarkdown(value, { images })
  return <div className="markdown-view" dangerouslySetInnerHTML={{ __html: html }} />
}
