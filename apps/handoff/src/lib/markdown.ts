import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.use({ gfm: true })

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md) as string
  return DOMPurify.sanitize(raw)
}
