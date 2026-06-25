import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown'

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
