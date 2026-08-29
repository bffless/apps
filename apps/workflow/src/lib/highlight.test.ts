/**
 * `splitHighlightedLines` (apps#380): cutting hljs markup into one string per
 * source line so `CodeView` can number the highlighted path too. The case that
 * matters is a token span crossing a line break — a block comment, a template
 * literal — which a naive `split('\n')` would leave unbalanced.
 */
import { describe, expect, it } from 'vitest'
import { highlightCode, splitHighlightedLines } from './highlight'

/** Every `<span>` opened is closed, in order — the property each line must hold. */
function balanced(html: string): boolean {
  let depth = 0
  for (const tag of html.match(/<\/?span[^>]*>/g) ?? []) {
    depth += tag.startsWith('</') ? -1 : 1
    if (depth < 0) return false
  }
  return depth === 0
}

describe('splitHighlightedLines', () => {
  it('returns one entry per line, preserving the text', () => {
    expect(splitHighlightedLines('one\ntwo\nthree')).toEqual(['one', 'two', 'three'])
  })

  it('returns a single entry for source with no line break', () => {
    expect(splitHighlightedLines('just one line')).toEqual(['just one line'])
  })

  it('keeps a span that ends on its own line intact', () => {
    expect(splitHighlightedLines('<span class="hljs-keyword">const</span> x\ny')).toEqual([
      '<span class="hljs-keyword">const</span> x',
      'y',
    ])
  })

  it('closes and re-opens a span that straddles a line break', () => {
    expect(splitHighlightedLines('<span class="hljs-comment">/* a\nb */</span> x')).toEqual([
      '<span class="hljs-comment">/* a</span>',
      '<span class="hljs-comment">b */</span> x',
    ])
  })

  it('re-opens every level of a nested span stack', () => {
    const [first, second] = splitHighlightedLines(
      '<span class="hljs-string">"a<span class="hljs-subst">${x\n}</span>b"</span>',
    )
    expect(first).toBe('<span class="hljs-string">"a<span class="hljs-subst">${x</span></span>')
    expect(second).toBe('<span class="hljs-string"><span class="hljs-subst">}</span>b"</span>')
  })

  it('leaves a trailing newline as a final empty line, matching the plain path', () => {
    expect(splitHighlightedLines('a\n')).toEqual(['a', ''])
  })

  it('leaves an unterminated tag verbatim rather than dropping the rest', () => {
    expect(splitHighlightedLines('a <span class="x')).toEqual(['a <span class="x'])
  })

  it('balances every line of real hljs output over multi-line source', () => {
    const source = [
      '/**',
      ' * A block comment that spans lines.',
      ' */',
      'function greet(name) {',
      '  return `hello ${name}`',
      '}',
    ].join('\n')
    const { html } = highlightCode(source, 'javascript')
    expect(html).not.toBeNull()

    const lines = splitHighlightedLines(html!)
    expect(lines).toHaveLength(6)
    for (const line of lines) expect(balanced(line), line).toBe(true)

    // Reassembling the lines must restore the original markup's text content.
    const text = (s: string) => s.replace(/<[^>]+>/g, '')
    expect(lines.map(text).join('\n')).toBe(text(html!))
  })
})
