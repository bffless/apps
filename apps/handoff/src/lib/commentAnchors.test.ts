import { describe, it, expect } from 'vitest'
import {
  buildTextIndex, anchorFromRange, resolveTextAnchor, rangeFromSpan, CONTEXT_CHARS,
} from './commentAnchors'
import type { CommentAnchorText } from './comments'

const anchor = (over: Partial<CommentAnchorText>): CommentAnchorText => ({
  type: 'text', quote: 'target phrase', prefix: 'before the ', suffix: ' and after',
  start: 100, end: 113, ...over,
})

describe('resolveTextAnchor', () => {
  it('finds the exact quote at the stored offset', () => {
    const text = 'x'.repeat(100) + 'target phrase' + 'y'.repeat(50)
    expect(resolveTextAnchor(text, anchor({}))).toEqual({ start: 100, end: 113 })
  })

  it('finds the quote when it moved', () => {
    const text = 'moved! target phrase tail'
    expect(resolveTextAnchor(text, anchor({}))).toEqual({ start: 7, end: 20 })
  })

  it('disambiguates duplicates by prefix/suffix', () => {
    const text = 'aaa target phrase zzz ... before the target phrase and after'
    const r = resolveTextAnchor(text, anchor({}))
    expect(text.slice(r!.start - 11, r!.start)).toBe('before the ')
  })

  it('prefers the occurrence nearest the stored start when context ties', () => {
    const text = 'target phrase ' + 'x'.repeat(200) + 'target phrase'
    const r = resolveTextAnchor(text, anchor({ prefix: '', suffix: '', start: 210 }))
    expect(r!.start).toBe(214)
  })

  it('fuzzy-matches when whitespace changed', () => {
    const text = 'before   the\n target   phrase and  after'
    const r = resolveTextAnchor(text, anchor({}))
    expect(text.slice(r!.start, r!.end).replace(/\s+/g, ' ')).toBe('target phrase')
  })

  it('returns null when the quote is gone', () => {
    expect(resolveTextAnchor('completely different content', anchor({}))).toBeNull()
  })

  it('returns null for an empty quote', () => {
    expect(resolveTextAnchor('anything', anchor({ quote: '' }))).toBeNull()
  })
})

describe('buildTextIndex + anchorFromRange + rangeFromSpan (jsdom)', () => {
  function setup(html: string) {
    document.body.innerHTML = html
    return buildTextIndex(document.body)
  }

  it('round-trips a selection to an anchor and back', () => {
    const index = setup('<p>Hello <b>brave</b> world</p>')
    expect(index.text).toBe('Hello brave world')
    const range = document.createRange()
    const bold = document.querySelector('b')!.firstChild!
    range.setStart(bold, 0)
    range.setEnd(bold, 5)
    const a = anchorFromRange(index, range)
    expect(a).toMatchObject({ quote: 'brave', start: 6, end: 11 })
    expect(a!.prefix).toBe('Hello ')
    expect(a!.prefix.length).toBeLessThanOrEqual(CONTEXT_CHARS)

    const back = rangeFromSpan(index, a!.start, a!.end, document)
    expect(back!.toString()).toBe('brave')
  })

  it('spans element boundaries', () => {
    const index = setup('<p>one <em>two</em> three</p>')
    const r = rangeFromSpan(index, 2, 9, document) // "e two t"
    expect(r!.toString()).toBe('e two t')
  })

  it('anchorFromRange returns null for a collapsed range', () => {
    const index = setup('<p>abc</p>')
    const range = document.createRange()
    const t = document.querySelector('p')!.firstChild!
    range.setStart(t, 1); range.setEnd(t, 1)
    expect(anchorFromRange(index, range)).toBeNull()
  })
})
