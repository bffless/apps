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

  it('renders a GFM table as <table> with its header and body rows (marked has GFM on)', () => {
    const div = document.createElement('div')
    div.innerHTML = renderMarkdown('| Field | Type |\n| --- | :-: |\n| id | string |')
    expect(div.querySelector('table thead th')?.textContent).toBe('Field')
    expect(div.querySelectorAll('table tbody td')).toHaveLength(2)
    expect(div.querySelector('table tbody td:nth-child(2)')?.textContent).toBe('string')
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

  /**
   * 02 `images` (apps#446): a src listed in the map is drawn from the mapped
   * serve url with its alt as a caption; everything else is exactly as before.
   */
  describe('with an image map', () => {
    const url = '/api/uploads/workflows/r/blog/0/frames/frames/0/frame-01.jpg'
    const images = { 'frame:78': url, 'images/frame-01.jpg': url }

    it('rewrites a mapped placeholder token to a same-origin <img> with the alt as caption', () => {
      const div = document.createElement('div')
      div.innerHTML = renderMarkdown('![The diff](frame:78)', { images })
      const img = div.querySelector('.markdown-figure img')
      expect(img?.getAttribute('src')).toBe(url)
      expect(img?.getAttribute('alt')).toBe('The diff')
      expect(div.querySelector('.markdown-caption')?.textContent).toBe('The diff')
    })

    it('rewrites a mapped relative path the same way', () => {
      const div = document.createElement('div')
      div.innerHTML = renderMarkdown('![zip](images/frame-01.jpg)', { images })
      expect(div.querySelector('img')?.getAttribute('src')).toBe(url)
    })

    it('still drops an unmapped unsafe-scheme src to its alt text', () => {
      const div = document.createElement('div')
      div.innerHTML = renderMarkdown('![Never captured](frame:99)', { images })
      expect(div.querySelector('img')).toBeNull()
      expect(div.textContent?.trim()).toBe('Never captured')
    })

    it('leaves an unmapped relative src untouched, and renders identically with no map at all', () => {
      const source = '![a](images/other.jpg) and ![b](frame:99)'
      const mapped = renderMarkdown(source, { images })
      expect(mapped).toBe(renderMarkdown(source))
      expect(mapped).toContain('src="images/other.jpg"')
      expect(mapped).not.toContain('markdown-figure')
    })

    it('refuses a mapped url outside the file-serve route and falls back to the unmapped behaviour', () => {
      const hostile = {
        'frame:1': '/api/workflow/runs/run_1',
        'frame:2': '//evil.example/x.jpg',
        'frame:3': 'https://evil.example/x.jpg',
        'frame:4': '/api/uploads/../workflow/runs',
      }
      const div = document.createElement('div')
      div.innerHTML = renderMarkdown('![a](frame:1) ![b](frame:2) ![c](frame:3) ![d](frame:4)', { images: hostile })
      expect(div.querySelector('img')).toBeNull()
      expect(div.textContent?.trim()).toBe('a b c d')
    })

    it('escapes a hostile alt on a mapped image, in both the attribute and the caption', () => {
      const div = document.createElement('div')
      div.innerHTML = renderMarkdown('![" onerror="alert(1)](frame:78)', { images })
      const img = div.querySelector('img')
      expect(img?.hasAttribute('onerror')).toBe(false)
      expect(div.querySelector('.markdown-caption')?.textContent).toBe('" onerror="alert(1)')
      expect(div.querySelectorAll('[onerror]')).toHaveLength(0)
    })

    it('only honours own keys of the map', () => {
      const div = document.createElement('div')
      div.innerHTML = renderMarkdown('![x](constructor)', { images: {} })
      expect(div.querySelector('img')?.getAttribute('src')).toBe('constructor')
    })

    it('does not leak the map into a later render', () => {
      renderMarkdown('![a](frame:78)', { images })
      const div = document.createElement('div')
      div.innerHTML = renderMarkdown('![a](frame:78)')
      expect(div.querySelector('img')).toBeNull()
    })
  })
})
