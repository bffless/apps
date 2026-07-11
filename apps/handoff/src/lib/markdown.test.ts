import { describe, it, expect } from 'vitest'
import { renderMarkdown, markdownDocument } from './markdown'

describe('renderMarkdown', () => {
  it('renders # H1 as <h1>', () => {
    const html = renderMarkdown('# Hello')
    expect(html).toContain('<h1>')
    expect(html).toContain('Hello')
  })

  it('renders **bold** as <strong>', () => {
    const html = renderMarkdown('**bold**')
    expect(html).toContain('<strong>')
    expect(html).toContain('bold')
  })

  it('renders fenced code block', () => {
    const html = renderMarkdown('```js\nconsole.log("hi")\n```')
    expect(html).toContain('<code')
    expect(html).toContain('console.log')
  })

  it('strips <script> tags (sanitized)', () => {
    const html = renderMarkdown('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('alert(1)')
  })

  it('neutralizes javascript: links', () => {
    const html = renderMarkdown('[click](javascript:alert(1))')
    expect(html).not.toContain('javascript:alert')
  })

  it('passes through plain text', () => {
    const html = renderMarkdown('Hello world')
    expect(html).toContain('Hello world')
  })
})

describe('markdownDocument', () => {
  it('injects a <base href> from the viewer base so relative refs resolve', () => {
    const doc = markdownDocument('<p>hi</p>', '/api/uploads/content/Design Docs/')
    expect(doc).toContain('<base href="/api/uploads/content/Design Docs/">')
    expect(doc).toContain('<div class="markdown-body"><p>hi</p></div>')
  })

  it('inlines the markdown-body styling', () => {
    const doc = markdownDocument('<p>hi</p>', '/api/uploads/content/')
    expect(doc).toContain('.markdown-body')
    expect(doc).toContain('<style>')
  })

  it('omits the <base> tag when there is no base', () => {
    const doc = markdownDocument('<p>hi</p>', null)
    expect(doc).not.toContain('<base')
  })

  it('embeds the rendered body verbatim (no re-rewriting of relative src)', () => {
    const body = renderMarkdown('![logo](assets/logo.png)')
    const doc = markdownDocument(body, '/api/uploads/content/Docs/')
    // The stored relative src is preserved; the <base> does the resolution.
    expect(doc).toContain('src="assets/logo.png"')
  })

  it('keeps Handoff’s own reading measure by default', () => {
    const doc = markdownDocument('<p>hi</p>', null)
    // The base rule caps the column; no measure-lifting override is appended.
    expect(doc).toContain('.markdown-body { max-width: 48rem;')
    expect(doc).not.toContain('max-width: none')
  })

  it('lifts the reading measure in embed mode so the host controls width', () => {
    const doc = markdownDocument('<p>hi</p>', null, { embed: true })
    // Override appended after the base CSS wins the cascade → content fills the frame.
    expect(doc).toContain('max-width: none')
  })

  const BASE = '/api/uploads/content/Docs/'

  it('opens a cross-origin link in a new tab', () => {
    const doc = markdownDocument('<a href="https://github.com/bffless/ce/issues/446">446</a>', BASE)
    expect(doc).toContain('href="https://github.com/bffless/ce/issues/446"')
    expect(doc).toContain('target="_blank"')
    expect(doc).toContain('rel="noopener noreferrer"')
  })

  it('routes a relative sibling link to that file’s viewer page, preserving encoding', () => {
    const doc = markdownDocument('<a href="other doc.md">next</a>', BASE)
    expect(doc).toContain('href="/blob/Docs/other%20doc.md"')
    expect(doc).toContain('target="_top"')
  })

  it('leaves an in-document anchor alone', () => {
    const doc = markdownDocument('<a href="#section-2">jump</a>', BASE)
    expect(doc).toContain('href="#section-2"')
    expect(doc).not.toContain('target=')
  })

  it('targets the top window for a same-origin app link', () => {
    const doc = markdownDocument('<a href="/tree/Docs">folder</a>', BASE)
    expect(doc).toContain('href="/tree/Docs"')
    expect(doc).toContain('target="_top"')
  })

  it('leaves a mailto: link alone', () => {
    const doc = markdownDocument('<a href="mailto:a@b.com">mail</a>', BASE)
    expect(doc).toContain('href="mailto:a@b.com"')
    expect(doc).not.toContain('target=')
  })

  it('opens internal links in a new tab in embed mode — never navigates the host', () => {
    const doc = markdownDocument('<a href="other.md">next</a>', BASE, { embed: true })
    expect(doc).toContain('href="/blob/Docs/other.md"')
    expect(doc).toContain('target="_blank"')
    expect(doc).not.toContain('target="_top"')
  })

  it('does not touch image sources', () => {
    const doc = markdownDocument(renderMarkdown('![logo](assets/logo.png)'), BASE)
    expect(doc).toContain('src="assets/logo.png"')
  })
})
