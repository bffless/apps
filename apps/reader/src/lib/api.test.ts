import { describe, it, expect, vi, afterEach } from 'vitest'
import { setFeedFolder, listItems } from './api'
import type { Feed } from './feeds'

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const feed: Feed = {
  url: 'https://example.com/feed.xml',
  title: 'Example',
  siteUrl: 'https://example.com',
  folder: null,
  iconUrl: 'https://example.com/icon.png',
  lastFetchedAt: 123,
  lastError: null,
  addedAt: 999,
}

describe('setFeedFolder', () => {
  it('writes via the /api/feeds/folder update endpoint, sending only url + folder', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ ok: true, updated: true }))
    vi.stubGlobal('fetch', fetchMock)

    await setFeedFolder(feed, 'macro')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    // Must hit the dedicated update path, NOT the insert-only add endpoint.
    expect(path).toBe('/api/feeds/folder')
    expect(init.method).toBe('POST')
    // Only url + folder — no title/siteUrl/addedAt resubmit (that was the bug).
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://example.com/feed.xml',
      folder: 'macro',
    })
  })

  it('normalizes an empty/whitespace folder to null (move to uncategorized)', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ ok: true, updated: true }))
    vi.stubGlobal('fetch', fetchMock)

    await setFeedFolder(feed, '   ')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://example.com/feed.xml',
      folder: null,
    })
  })

  it('trims a folder name before sending', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ ok: true, updated: true }))
    vi.stubGlobal('fetch', fetchMock)

    await setFeedFolder(feed, '  macro  ')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://example.com/feed.xml',
      folder: 'macro',
    })
  })

  it('throws before hitting the network when the feed has no url', async () => {
    const fetchMock = vi.fn(async () => jsonOk({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(setFeedFolder({ ...feed, url: '' }, 'macro')).rejects.toThrow(/url is required/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('listItems', () => {
  it('carries enclosureType from the /api/items response through shapeItem into the page', async () => {
    // Raw /api/items rows are untyped JSON (Record<string, unknown>).
    const withType: Record<string, unknown> = {
      guid: 'g-markdown',
      feedId: 'f1',
      title: 'A Handoff markdown post',
      link: 'https://handoff.example.com/p/abc',
      enclosureType: 'text/markdown',
    }
    const withoutType: Record<string, unknown> = {
      guid: 'g-plain',
      feedId: 'f1',
      title: 'A plain post',
      link: 'https://example.com/p/xyz',
      // no enclosureType key at all
    }
    const fetchMock = vi.fn(async () =>
      jsonOk({ items: [withType, withoutType], total: 2, page: 1, pageSize: 20, totalPages: 1 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const page = await listItems({ kind: 'all' }, {})

    // The markdown enclosureType survives the transport → shapeItem mapping (drives isEmbeddable).
    expect(page.items[0].enclosureType).toBe('text/markdown')
    // A missing enclosureType coerces to null via str(), not undefined/'' — proving the default carries through.
    expect(page.items[1].enclosureType).toBeNull()
  })
})
