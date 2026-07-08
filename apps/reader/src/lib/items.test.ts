import { describe, it, expect } from 'vitest'
import { shapeItem, itemTimestamp, itemPreview, itemBodyHtml } from './items'

describe('shapeItem', () => {
  it('coerces a full row including boolean flags', () => {
    const it_ = shapeItem({
      guid: 'g1',
      feedId: 'https://x.test/rss',
      title: 'Post',
      link: 'https://x.test/post',
      author: 'Ada',
      publishedAt: '2026-01-02T03:04:05Z',
      summary: '<p>hi</p>',
      content: '<p>hello</p>',
      read: 'true',
      starred: false,
      fetchedAt: 1700000000000,
    })
    expect(it_.guid).toBe('g1')
    expect(it_.read).toBe(true)
    expect(it_.starred).toBe(false)
    expect(it_.fetchedAt).toBe(1700000000000)
  })

  it('defaults flags to false and blanks to null for a sparse row', () => {
    const it_ = shapeItem({ guid: 'g2', feedId: 'f' })
    expect(it_.read).toBe(false)
    expect(it_.starred).toBe(false)
    expect(it_.link).toBeNull()
    expect(it_.content).toBeNull()
  })

  it('reads legacy numeric/string boolean encodings', () => {
    expect(shapeItem({ read: 1, starred: '1' }).read).toBe(true)
    expect(shapeItem({ read: 1, starred: '1' }).starred).toBe(true)
  })

  it('carries enclosureType when present, null when missing/empty', () => {
    expect(shapeItem({ enclosureType: 'text/markdown' }).enclosureType).toBe('text/markdown')
    expect(shapeItem({}).enclosureType).toBeNull()
    expect(shapeItem({ enclosureType: '' }).enclosureType).toBeNull()
  })
})

describe('itemTimestamp', () => {
  it('parses an ISO publishedAt', () => {
    expect(itemTimestamp(shapeItem({ publishedAt: '2026-01-01T00:00:00Z' }))).toBe(
      Date.parse('2026-01-01T00:00:00Z'),
    )
  })

  it('parses an RFC-822 publishedAt', () => {
    expect(itemTimestamp(shapeItem({ publishedAt: 'Wed, 01 Jan 2026 00:00:00 GMT' }))).toBe(
      Date.parse('2026-01-01T00:00:00Z'),
    )
  })

  it('falls back to fetchedAt when publishedAt is missing/unparseable', () => {
    expect(itemTimestamp(shapeItem({ fetchedAt: 42 }))).toBe(42)
    expect(itemTimestamp(shapeItem({ publishedAt: 'not a date', fetchedAt: 7 }))).toBe(7)
  })

  it('is 0 when nothing is known', () => {
    expect(itemTimestamp(shapeItem({}))).toBe(0)
  })
})

describe('itemPreview', () => {
  it('flattens summary HTML to plain text', () => {
    expect(itemPreview(shapeItem({ summary: '<p>Hello <b>world</b></p>' }))).toBe('Hello world')
  })

  it('falls back to content when summary is absent', () => {
    expect(itemPreview(shapeItem({ content: '<p>body text</p>' }))).toBe('body text')
  })

  it('truncates with an ellipsis past maxLen', () => {
    const long = 'word '.repeat(100)
    const preview = itemPreview(shapeItem({ summary: long }), 20)
    expect(preview.length).toBeLessThanOrEqual(21)
    expect(preview.endsWith('…')).toBe(true)
  })

  it('never leaks script content', () => {
    expect(itemPreview(shapeItem({ summary: 'safe<script>alert(1)</script>' }))).toBe('safe')
  })
})

describe('itemBodyHtml', () => {
  it('prefers content, falls back to summary', () => {
    expect(itemBodyHtml(shapeItem({ content: '<p>full</p>', summary: '<p>s</p>' }))).toBe(
      '<p>full</p>',
    )
    expect(itemBodyHtml(shapeItem({ summary: '<p>s</p>' }))).toBe('<p>s</p>')
    expect(itemBodyHtml(shapeItem({}))).toBe('')
  })
})
