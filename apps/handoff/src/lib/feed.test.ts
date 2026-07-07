import { describe, it, expect } from 'vitest'
import { selectFeedItems, renderFeedXml, FEED_ITEM_LIMIT, type FeedContext } from './feed'
import type { HandoffNode } from './nodes'

function node(partial: Partial<HandoffNode> & Pick<HandoffNode, 'id' | 'type'>): HandoffNode {
  return {
    id: partial.id,
    type: partial.type,
    name: partial.name ?? partial.id,
    mime: partial.mime ?? null,
    size: partial.size ?? null,
    url: partial.url ?? null,
    storageKey: partial.storageKey ?? null,
    path: partial.path ?? null,
    parentId: partial.parentId ?? 'root',
    createdAt: partial.createdAt ?? 0,
    ownerId: partial.ownerId ?? null,
    grants: partial.grants ?? [],
    mode: partial.mode ?? 'inheriting',
  }
}

describe('selectFeedItems', () => {
  it('keeps only file/site leaves, drops folders and pathless leaves', () => {
    const items = selectFeedItems([
      node({ id: 'fld', type: 'folder', path: 'Docs' }),
      node({ id: 'f1', type: 'file', path: 'Docs/a.png', createdAt: 1 }),
      node({ id: 's1', type: 'site', path: 'Docs/site', createdAt: 2 }),
      node({ id: 'nopath', type: 'file', path: null, createdAt: 3 }),
    ])
    expect(items.map((i) => i.id)).toEqual(['s1', 'f1'])
  })

  it('orders newest-first by createdAt', () => {
    const items = selectFeedItems([
      node({ id: 'old', type: 'file', path: 'a', createdAt: 100 }),
      node({ id: 'new', type: 'file', path: 'b', createdAt: 300 }),
      node({ id: 'mid', type: 'file', path: 'c', createdAt: 200 }),
    ])
    expect(items.map((i) => i.id)).toEqual(['new', 'mid', 'old'])
  })

  it(`caps at the ${FEED_ITEM_LIMIT} most recent`, () => {
    const many = Array.from({ length: FEED_ITEM_LIMIT + 10 }, (_, i) =>
      node({ id: `f${i}`, type: 'file', path: `p${i}`, createdAt: i }),
    )
    const items = selectFeedItems(many)
    expect(items).toHaveLength(FEED_ITEM_LIMIT)
    // Newest (highest createdAt) kept; oldest dropped.
    expect(items[0].id).toBe(`f${FEED_ITEM_LIMIT + 9}`)
    expect(items.some((i) => i.id === 'f0')).toBe(false)
  })
})

describe('renderFeedXml', () => {
  const ctx: FeedContext = {
    origin: 'https://handoff.j5s.dev',
    title: 'Docs',
    description: 'Files in Docs',
    folderPath: 'Docs',
  }

  it('emits a valid empty channel for zero items', () => {
    const xml = renderFeedXml([], ctx)
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<rss version="2.0"')
    expect(xml).toContain('<title>Docs</title>')
    expect(xml).toContain('<link>https://handoff.j5s.dev/tree/Docs</link>')
    expect(xml).toContain('rel="self"')
    expect(xml).not.toContain('<item>')
  })

  it('renders a File item with a blob link + enclosure (mime/length)', () => {
    const xml = renderFeedXml(
      selectFeedItems([
        node({ id: 'file-1', type: 'file', name: 'My File.png', path: 'Docs/My File.png', mime: 'image/png', size: 2048, createdAt: 0 }),
      ]),
      ctx,
    )
    expect(xml).toContain('<guid isPermaLink="false">file-1</guid>')
    // path is surfaced through the item link (per-segment encoded).
    expect(xml).toContain('<link>https://handoff.j5s.dev/blob/Docs/My%20File.png</link>')
    expect(xml).toContain('<enclosure url="https://handoff.j5s.dev/r/file-1/my-file.png" type="image/png" length="2048"/>')
  })

  it('renders a Site item as a single link with no enclosure', () => {
    const xml = renderFeedXml(
      selectFeedItems([node({ id: 'site-1', type: 'site', name: 'Portfolio', path: 'Docs/Portfolio', createdAt: 0 })]),
      ctx,
    )
    expect(xml).toContain('<link>https://handoff.j5s.dev/blob/Docs/Portfolio</link>')
    expect(xml).not.toContain('<enclosure')
  })

  it('XML-escapes names', () => {
    const xml = renderFeedXml(
      selectFeedItems([node({ id: 'x', type: 'file', name: 'a & b <c>.txt', path: 'Docs/x.txt', mime: 'text/plain', size: 1, createdAt: 0 })]),
      ctx,
    )
    expect(xml).toContain('<title>a &amp; b &lt;c&gt;.txt</title>')
  })

  it('root folder feed uses the root tree link and /feed.xml self href', () => {
    const xml = renderFeedXml([], { ...ctx, folderPath: '', title: 'My Files' })
    expect(xml).toContain('<link>https://handoff.j5s.dev/</link>')
    expect(xml).toContain('href="https://handoff.j5s.dev/feed.xml"')
  })

  it('threads a private feed token into the self href, item links, and enclosures (#189)', () => {
    const tok = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const xml = renderFeedXml(
      selectFeedItems([
        node({ id: 'file-1', type: 'file', name: 'a.png', path: 'Docs/a.png', mime: 'image/png', size: 10, createdAt: 0 }),
        node({ id: 'site-1', type: 'site', name: 'Portfolio', path: 'Docs/Portfolio', createdAt: 1 }),
      ]),
      { ...ctx, token: tok },
    )
    // Self href carries the token so a reader re-fetching the feed keeps access.
    expect(xml).toContain(`href="https://handoff.j5s.dev/feed/Docs.xml?token=${tok}"`)
    // Every item link and enclosure carries the token (File + Site).
    expect(xml).toContain(`<link>https://handoff.j5s.dev/blob/Docs/a.png?token=${tok}</link>`)
    expect(xml).toContain(`<link>https://handoff.j5s.dev/blob/Docs/Portfolio?token=${tok}</link>`)
    expect(xml).toContain(`<enclosure url="https://handoff.j5s.dev/r/file-1/a.png?token=${tok}" type="image/png" length="10"/>`)
  })

  it('a public feed (no token) keeps item links and enclosures tokenless', () => {
    const xml = renderFeedXml(
      selectFeedItems([node({ id: 'f', type: 'file', name: 'a.png', path: 'Docs/a.png', mime: 'image/png', size: 10, createdAt: 0 })]),
      ctx,
    )
    expect(xml).not.toContain('?token=')
  })
})
