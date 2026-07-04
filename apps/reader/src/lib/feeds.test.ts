import { describe, it, expect } from 'vitest'
import { normalizeFeedUrl, shapeFeed, feedLabel, feedInitial, sortFeeds, type Feed } from './feeds'

describe('normalizeFeedUrl', () => {
  it('defaults a missing scheme to https', () => {
    expect(normalizeFeedUrl('example.com/feed')).toBe('https://example.com/feed')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeFeedUrl('  https://example.com/feed  ')).toBe('https://example.com/feed')
  })

  it('lowercases scheme and host but preserves path case', () => {
    expect(normalizeFeedUrl('HTTPS://Example.COM/Feed')).toBe('https://example.com/Feed')
  })

  it('dedupes a trailing slash on a real path but keeps a bare-origin slash', () => {
    expect(normalizeFeedUrl('https://example.com/feed/')).toBe('https://example.com/feed')
    expect(normalizeFeedUrl('https://example.com')).toBe('https://example.com/')
  })

  it('drops the fragment', () => {
    expect(normalizeFeedUrl('https://example.com/feed#top')).toBe('https://example.com/feed')
  })

  it('so two spellings of the same feed collapse to one key', () => {
    const a = normalizeFeedUrl('Example.com/Feed/')
    const b = normalizeFeedUrl('https://example.com/Feed')
    expect(a).toBe(b)
  })

  it('rejects empty or non-http input', () => {
    expect(normalizeFeedUrl('')).toBe('')
    expect(normalizeFeedUrl('   ')).toBe('')
    expect(normalizeFeedUrl('javascript:alert(1)')).toBe('')
    expect(normalizeFeedUrl('mailto:a@b.com')).toBe('')
  })
})

describe('shapeFeed', () => {
  it('coerces a full row', () => {
    const f = shapeFeed({
      url: 'https://example.com/feed',
      title: 'Example',
      siteUrl: 'https://example.com',
      folder: 'News',
      iconUrl: 'https://example.com/icon.png',
      lastFetchedAt: 1700000000000,
      lastError: null,
      addedAt: '1699999999999',
    })
    expect(f).toEqual({
      url: 'https://example.com/feed',
      title: 'Example',
      siteUrl: 'https://example.com',
      folder: 'News',
      iconUrl: 'https://example.com/icon.png',
      lastFetchedAt: 1700000000000,
      lastError: null,
      addedAt: 1699999999999,
    })
  })

  it('fills sensible blanks for a sparse row', () => {
    const f = shapeFeed({ url: 'https://x.test/rss' })
    expect(f.url).toBe('https://x.test/rss')
    expect(f.title).toBe('')
    expect(f.folder).toBeNull()
    expect(f.lastFetchedAt).toBeNull()
  })
})

describe('feedLabel', () => {
  it('prefers the title', () => {
    expect(feedLabel(shapeFeed({ url: 'https://x.test/rss', title: 'My Blog' }))).toBe('My Blog')
  })

  it('falls back to host + path when untitled', () => {
    expect(feedLabel(shapeFeed({ url: 'https://x.test/rss' }))).toBe('x.test/rss')
    expect(feedLabel(shapeFeed({ url: 'https://x.test/' }))).toBe('x.test')
  })
})

describe('feedInitial', () => {
  it('takes the first letter of the title, uppercased', () => {
    expect(feedInitial(shapeFeed({ url: 'https://x.test/rss', title: 'alpha Blog' }))).toBe('A')
  })

  it('derives from the host when untitled', () => {
    expect(feedInitial(shapeFeed({ url: 'https://beta.test/rss' }))).toBe('B')
  })

  it('skips leading punctuation to the first alphanumeric', () => {
    expect(feedInitial(shapeFeed({ url: 'https://x.test/rss', title: '“Quoted” News' }))).toBe('Q')
    expect(feedInitial(shapeFeed({ url: 'https://x.test/rss', title: '7 Days' }))).toBe('7')
  })

  it('falls back to a dot for a label with no alphanumerics', () => {
    expect(feedInitial(shapeFeed({ url: 'https://x.test/rss', title: '★' }))).toBe('•')
  })
})

describe('sortFeeds', () => {
  it('orders by label case-insensitively without mutating input', () => {
    const feeds: Feed[] = [
      shapeFeed({ url: 'https://z.test/f', title: 'zebra' }),
      shapeFeed({ url: 'https://a.test/f', title: 'Apple' }),
      shapeFeed({ url: 'https://b.test/f', title: 'banana' }),
    ]
    const sorted = sortFeeds(feeds)
    expect(sorted.map((f) => f.title)).toEqual(['Apple', 'banana', 'zebra'])
    expect(feeds[0].title).toBe('zebra')
  })
})
