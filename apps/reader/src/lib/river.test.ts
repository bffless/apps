import { describe, it, expect } from 'vitest'
import {
  itemsForSelection,
  unreadCountsByFeed,
  totalUnread,
  totalStarred,
  setRead,
  setStarred,
  markGuidsRead,
  unreadGuids,
  selectionKey,
  selectionEquals,
  type Selection,
} from './river'
import { shapeItem, type Item } from './items'

/** A tiny item factory keyed off the shaper so defaults match production shaping. */
function item(over: Partial<Item> & { guid: string }): Item {
  return shapeItem({
    feedId: 'https://a.test/rss',
    publishedAt: '2026-01-01T00:00:00Z',
    ...over,
  })
}

const sample: Item[] = [
  item({ guid: 'a1', feedId: 'https://a.test/rss', read: false, publishedAt: '2026-01-03T00:00:00Z' }),
  item({ guid: 'a2', feedId: 'https://a.test/rss', read: true, starred: true, publishedAt: '2026-01-04T00:00:00Z' }),
  item({ guid: 'b1', feedId: 'https://b.test/rss', read: false, publishedAt: '2026-01-02T00:00:00Z' }),
  item({ guid: 'b2', feedId: 'https://b.test/rss', read: false, starred: true, publishedAt: '2026-01-05T00:00:00Z' }),
]

describe('itemsForSelection', () => {
  it('river = unread across all feeds, newest first', () => {
    const river = itemsForSelection(sample, { kind: 'river' })
    expect(river.map((i) => i.guid)).toEqual(['b2', 'a1', 'b1'])
  })

  it('all = every item across feeds, newest first (read included)', () => {
    const all = itemsForSelection(sample, { kind: 'all' })
    expect(all.map((i) => i.guid)).toEqual(['b2', 'a2', 'a1', 'b1'])
  })

  it('feed = only that feed, newest first, read included', () => {
    const feed = itemsForSelection(sample, { kind: 'feed', url: 'https://a.test/rss' })
    expect(feed.map((i) => i.guid)).toEqual(['a2', 'a1'])
  })

  it('starred = every starred item across feeds (read or unread), newest first', () => {
    const starred = itemsForSelection(sample, { kind: 'starred' })
    expect(starred.map((i) => i.guid)).toEqual(['b2', 'a2'])
  })

  it('does not mutate the input', () => {
    const copy = [...sample]
    itemsForSelection(sample, { kind: 'river' })
    expect(sample).toEqual(copy)
  })
})

describe('unreadCountsByFeed', () => {
  it('counts unread per feed, omitting all-read feeds', () => {
    expect(unreadCountsByFeed(sample)).toEqual({
      'https://a.test/rss': 1,
      'https://b.test/rss': 2,
    })
  })

  it('omits a feed once every item is read', () => {
    const allRead = sample.map((i) => ({ ...i, read: true }))
    expect(unreadCountsByFeed(allRead)).toEqual({})
  })
})

describe('totalUnread', () => {
  it('sums unread across feeds', () => {
    expect(totalUnread(sample)).toBe(3)
  })
})

describe('totalStarred', () => {
  it('counts starred across feeds regardless of read state', () => {
    expect(totalStarred(sample)).toBe(2)
  })

  it('is zero when nothing is starred', () => {
    expect(totalStarred(sample.map((i) => ({ ...i, starred: false })))).toBe(0)
  })
})

describe('setStarred', () => {
  it('stars an item, leaving the rest referentially stable', () => {
    const next = setStarred(sample, 'a1', true)
    expect(next.find((i) => i.guid === 'a1')?.starred).toBe(true)
    expect(next.find((i) => i.guid === 'b1')).toBe(sample.find((i) => i.guid === 'b1'))
  })

  it('unstars an already-starred item', () => {
    expect(setStarred(sample, 'a2', false).find((i) => i.guid === 'a2')?.starred).toBe(false)
  })

  it('is a no-op when the flag already matches (same references)', () => {
    const next = setStarred(sample, 'a2', true)
    expect(next.every((i, idx) => i === sample[idx])).toBe(true)
  })
})

describe('setRead', () => {
  it('flips one item and leaves the rest referentially stable', () => {
    const next = setRead(sample, 'a1', true)
    expect(next.find((i) => i.guid === 'a1')?.read).toBe(true)
    expect(next.find((i) => i.guid === 'b1')).toBe(sample.find((i) => i.guid === 'b1'))
  })

  it('is a no-op when the flag already matches (same references)', () => {
    const next = setRead(sample, 'a2', true)
    expect(next.every((i, idx) => i === sample[idx])).toBe(true)
  })

  it('unmarks read → unread (manual toggle back)', () => {
    expect(setRead(sample, 'a2', false).find((i) => i.guid === 'a2')?.read).toBe(false)
  })
})

describe('markGuidsRead', () => {
  it('marks every listed guid read, once', () => {
    const next = markGuidsRead(sample, ['a1', 'b1'])
    expect(next.filter((i) => i.read).map((i) => i.guid).sort()).toEqual(['a1', 'a2', 'b1'])
  })

  it('accepts a Set and leaves untouched items referentially stable', () => {
    const next = markGuidsRead(sample, new Set(['a1']))
    expect(next.find((i) => i.guid === 'b2')).toBe(sample.find((i) => i.guid === 'b2'))
  })
})

describe('unreadGuids', () => {
  it('returns unread guids in input order', () => {
    expect(unreadGuids(sample)).toEqual(['a1', 'b1', 'b2'])
  })
})

describe('selection identity', () => {
  it('keys feeds by url and singletons by kind', () => {
    expect(selectionKey({ kind: 'river' })).toBe('river')
    expect(selectionKey({ kind: 'feed', url: 'u' })).toBe('feed:u')
  })

  it('equality compares the derived key', () => {
    const a: Selection = { kind: 'feed', url: 'u' }
    expect(selectionEquals(a, { kind: 'feed', url: 'u' })).toBe(true)
    expect(selectionEquals(a, { kind: 'all' })).toBe(false)
  })
})
