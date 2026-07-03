import { describe, it, expect } from 'vitest'
import { sanitizeHtml, htmlToText } from './sanitize'

describe('sanitizeHtml', () => {
  it('keeps benign formatting markup', () => {
    const html = sanitizeHtml('<p>Hello <strong>world</strong> and <em>all</em></p>')
    expect(html).toContain('<strong>')
    expect(html).toContain('<em>')
    expect(html).toContain('world')
  })

  it('strips <script> tags and their payload', () => {
    const html = sanitizeHtml('<p>ok</p><script>alert(1)</script>')
    expect(html).toContain('ok')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('removes inline event-handler attributes', () => {
    const html = sanitizeHtml('<img src="x" onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })

  it('neutralizes javascript: links', () => {
    const html = sanitizeHtml('<a href="javascript:alert(1)">click</a>')
    expect(html).not.toContain('javascript:')
  })

  it('adds target=_blank and a hardened rel to surviving links', () => {
    const html = sanitizeHtml('<a href="https://example.com">link</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer nofollow"')
  })

  it('drops iframes and forms (embedding vectors a reader never needs)', () => {
    const html = sanitizeHtml('<iframe src="https://evil.test"></iframe><form><input></form>')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
  })

  it('keeps images (feeds legitimately embed them)', () => {
    const html = sanitizeHtml('<img src="https://example.com/cat.png" alt="cat">')
    expect(html).toContain('<img')
    expect(html).toContain('cat.png')
  })

  it('returns empty string for nullish input', () => {
    expect(sanitizeHtml(null)).toBe('')
    expect(sanitizeHtml(undefined)).toBe('')
    expect(sanitizeHtml('')).toBe('')
  })
})

describe('htmlToText', () => {
  it('flattens markup to whitespace-collapsed plain text', () => {
    const text = htmlToText('<p>Hello   <strong>world</strong></p>\n<p>again</p>')
    expect(text).toBe('Hello world again')
  })

  it('never leaks script content into the preview', () => {
    const text = htmlToText('<p>safe</p><script>alert(1)</script>')
    expect(text).toBe('safe')
  })

  it('returns empty string for nullish input', () => {
    expect(htmlToText(null)).toBe('')
    expect(htmlToText('')).toBe('')
  })
})
