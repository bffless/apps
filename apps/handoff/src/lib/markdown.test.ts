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
})
