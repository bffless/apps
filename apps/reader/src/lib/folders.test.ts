import { describe, it, expect } from 'vitest'
import {
  normalizeFolder,
  groupFeedsByFolder,
  feedUrlsInFolder,
  folderUnread,
  folderNames,
} from './folders'
import { shapeFeed, type Feed } from './feeds'

/** A feed factory keyed off the shaper so defaults match production shaping. */
function feed(over: Partial<Feed> & { url: string }): Feed {
  return shapeFeed({ ...over })
}

const feeds: Feed[] = [
  feed({ url: 'https://a.test/rss', title: 'Alpha', folder: 'News' }),
  feed({ url: 'https://b.test/rss', title: 'Bravo', folder: 'news' }), // case-insensitive same group
  feed({ url: 'https://c.test/rss', title: 'Charlie', folder: 'Tech' }),
  feed({ url: 'https://d.test/rss', title: 'Delta' }), // uncategorized (null)
]

describe('normalizeFolder', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeFolder('  Tech  ')).toBe('Tech')
  })

  it('maps empty / whitespace-only to null (uncategorized)', () => {
    expect(normalizeFolder('')).toBeNull()
    expect(normalizeFolder('   ')).toBeNull()
  })
})

describe('folderNames', () => {
  it('lists distinct folder names, sorted case-insensitively, nulls excluded', () => {
    // 'News' and 'news' collapse to the first-seen label ('News').
    expect(folderNames(feeds)).toEqual(['News', 'Tech'])
  })
})

describe('groupFeedsByFolder', () => {
  it('groups by folder (case-insensitive), named folders sorted first, uncategorized last', () => {
    const groups = groupFeedsByFolder(feeds)
    expect(groups.map((g) => g.folder)).toEqual(['News', 'Tech', null])
  })

  it('sorts feeds within each group by label', () => {
    const groups = groupFeedsByFolder(feeds)
    const news = groups.find((g) => g.folder === 'News')!
    expect(news.feeds.map((f) => f.title)).toEqual(['Alpha', 'Bravo'])
  })

  it('returns an uncategorized group only when there are uncategorized feeds', () => {
    const only = groupFeedsByFolder([feed({ url: 'https://x.test/rss', folder: 'X' })])
    expect(only.map((g) => g.folder)).toEqual(['X'])
  })
})

describe('feedUrlsInFolder', () => {
  it('collects urls of feeds in a named folder, case-insensitively', () => {
    expect(feedUrlsInFolder(feeds, 'News')).toEqual(
      new Set(['https://a.test/rss', 'https://b.test/rss']),
    )
  })

  it('collects uncategorized feeds when folder is null', () => {
    expect(feedUrlsInFolder(feeds, null)).toEqual(new Set(['https://d.test/rss']))
  })
})

describe('folderUnread', () => {
  it('sums the per-feed unread counts across a group', () => {
    const groups = groupFeedsByFolder(feeds)
    const news = groups.find((g) => g.folder === 'News')!
    const byFeed = { 'https://a.test/rss': 3, 'https://b.test/rss': 2, 'https://c.test/rss': 9 }
    expect(folderUnread(byFeed, news.feeds)).toBe(5)
  })

  it('treats a feed with no entry as zero', () => {
    const groups = groupFeedsByFolder(feeds)
    const tech = groups.find((g) => g.folder === 'Tech')!
    expect(folderUnread({}, tech.feeds)).toBe(0)
  })
})
