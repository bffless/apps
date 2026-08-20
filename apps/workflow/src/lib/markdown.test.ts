/**
 * 05: "Summaries are markdown; HTML is not interpreted." This is the only
 * seam that turns markdown into an HTML string for `dangerouslySetInnerHTML`
 * (values/MarkdownView) — raw HTML in the source must come out escaped, and
 * unsafe link protocols must never reach an `href`.
 */
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('renders normal markdown constructs', () => {
    expect(renderMarkdown('**hi**')).toContain('<strong>hi</strong>')
  })

  it('escapes a block-level html token instead of interpreting it', () => {
    const html = renderMarkdown('**hi** <script>alert(1)</script>')
    expect(html).toContain('<strong>hi</strong>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('escapes an inline html token nested inside a paragraph', () => {
    const html = renderMarkdown('para with <b>x</b> inline')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>')
  })

  it('drops a javascript: href instead of emitting it', () => {
    const html = renderMarkdown('[link](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
  })

  it('keeps a normal https href intact', () => {
    const html = renderMarkdown('[link](https://example.com)')
    expect(html).toContain('href="https://example.com"')
  })
})
