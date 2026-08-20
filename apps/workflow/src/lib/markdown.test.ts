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

  it('drops an HTML-entity-encoded javascript: scheme (decodes only after DOM parse)', () => {
    const html = renderMarkdown('[link](javascript&#58;alert(1))')
    const div = document.createElement('div')
    div.innerHTML = html
    const a = div.querySelector('a')
    expect(a === null || a.protocol !== 'javascript:').toBe(true)
  })

  it('does not let a crafted href break out of the href attribute', () => {
    const html = renderMarkdown('[link](<https://a.com" onmouseover="alert(1)>)')
    const div = document.createElement('div')
    div.innerHTML = html
    const a = div.querySelector('a')
    expect(a).not.toBeNull()
    expect(a?.hasAttribute('onmouseover')).toBe(false)
    const attrNames = a ? Array.from(a.attributes).map((attr) => attr.name) : []
    expect(attrNames.every((name) => name === 'href' || name === 'title' || name === 'rel')).toBe(true)
  })

  it('drops a tab-split javascript: scheme', () => {
    const html = renderMarkdown('[link](java\tscript:alert(1))')
    const div = document.createElement('div')
    div.innerHTML = html
    const a = div.querySelector('a')
    expect(a === null || a.protocol !== 'javascript:').toBe(true)
  })
  it('escapes an alt-text injection payload instead of letting it become an attribute', () => {
    const html = renderMarkdown('![" onerror="alert(1)](x.png)')
    const div = document.createElement('div')
    div.innerHTML = html
    const img = div.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.hasAttribute('onerror')).toBe(false)
    expect(div.querySelectorAll('*').length).toBe(2) // <p><img>, nothing smuggled in
  })

  it('escapes an alt-text injection payload nested inside emphasis (hello\'s say summary)', () => {
    const html = renderMarkdown('Said **![" onerror="alert(1)](x)**')
    const div = document.createElement('div')
    div.innerHTML = html
    const img = div.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.hasAttribute('onerror')).toBe(false)
  })

  it('drops a javascript: image src instead of emitting an <img>', () => {
    const html = renderMarkdown('![a](javascript:alert(1))')
    expect(html).not.toContain('javascript:')
    const div = document.createElement('div')
    div.innerHTML = html
    expect(div.querySelector('img')).toBeNull()
    expect(div.textContent).toContain('a')
  })

  it('renders a normal image with exactly src and alt', () => {
    const html = renderMarkdown('![a](/api/workflow/files/x.png)')
    const div = document.createElement('div')
    div.innerHTML = html
    const img = div.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('/api/workflow/files/x.png')
    expect(img?.getAttribute('alt')).toBe('a')
    expect(Array.from(img!.attributes).map((a) => a.name).sort()).toEqual(['alt', 'src'])
  })

  it('emits no event-handler attribute and no unsafe url anywhere in a hostile document', () => {
    const source = [
      '# Report',
      '',
      '[ok](https://example.com) [js](javascript:alert(1)) [entity](javascript&#58;alert(2))',
      '',
      '![shot" onerror="alert(3)](/api/workflow/files/a.png)',
      '',
      '![js](javascript:alert(4))',
      '',
      '<img src=x onerror="alert(5)">',
      '',
      'Said **![" onerror="alert(6)](x)** and *[t](vbscript:alert(7))*',
      '',
      '| a | b |',
      '| --- | --- |',
      '| <script>alert(8)</script> | [c](javascript:alert(9)) |',
    ].join('\n')

    const div = document.createElement('div')
    div.innerHTML = renderMarkdown(source)

    for (const el of Array.from(div.querySelectorAll('*'))) {
      const handlers = Array.from(el.attributes)
        .map((attr) => attr.name)
        .filter((name) => name.toLowerCase().startsWith('on'))
      expect(handlers).toEqual([])
    }

    for (const el of Array.from(div.querySelectorAll('[href], [src]'))) {
      const raw = el.getAttribute('href') ?? el.getAttribute('src') ?? ''
      expect(['http:', 'https:', 'mailto:']).toContain(new URL(raw, 'https://harness.test/base/').protocol)
    }

    expect(div.querySelector('script')).toBeNull()
    expect(div.innerHTML).not.toMatch(/javascript:|vbscript:/i)
  })
})
