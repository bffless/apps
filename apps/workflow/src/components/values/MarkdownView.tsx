/**
 * The `markdown` type's default viewer (02) and the ONLY component allowed
 * to use `dangerouslySetInnerHTML` — and only with `renderMarkdown()` output,
 * which escapes raw HTML rather than interpreting it (05).
 */
import { renderMarkdown } from '../../lib/markdown'

export function MarkdownView({ value }: { value: string }) {
  const html = renderMarkdown(value)
  return <div className="markdown-view" dangerouslySetInnerHTML={{ __html: html }} />
}
