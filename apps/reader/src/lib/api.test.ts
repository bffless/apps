import { describe, it, expect, vi, afterEach } from 'vitest'
import { setFeedFolder } from './api'
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
