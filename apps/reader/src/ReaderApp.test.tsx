import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ReaderApp } from './ReaderApp'
import * as api from './lib/api'
import type { Item } from './lib/items'
import type { ItemsPage, Counts } from './lib/api'

// `lib/api` is the transport seam; the component's job is *which* calls it makes
// with *what* args. Auto-mock the whole module and drive the fetch/counts
// behavior from the mocked resolutions. jsdom has no `matchMedia`, so
// `useMediaQuery` reports false → the mobile single-pane branch renders (no
// resizable panels), which is what these assertions exercise.
vi.mock('./lib/api')

const FEED_URL = 'https://example.com/feed'
const FEED_SEL = { kind: 'feed' as const, url: FEED_URL }

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    guid: 'g1',
    feedId: FEED_URL,
    title: 'First article',
    link: 'https://example.com/1',
    author: null,
    publishedAt: '2026-07-01T00:00:00Z',
    summary: 'summary',
    content: '<p>body</p>',
    read: false,
    starred: false,
    fetchedAt: 1,
    ...overrides,
  }
}

function makePage(items: Item[], total = items.length): ItemsPage {
  return { items, total, page: 1, pageSize: 20, totalPages: Math.max(1, Math.ceil(total / 20)) }
}

const EMPTY_COUNTS: Counts = { unreadByFeed: {}, starred: 0 }

/** Mirror the App.tsx route table, rendering ReaderApp for each navigable view. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route index element={<ReaderApp />} />
        <Route path="item/:itemId" element={<ReaderApp />} />
        <Route path="all" element={<ReaderApp />} />
        <Route path="all/item/:itemId" element={<ReaderApp />} />
        <Route path="starred" element={<ReaderApp />} />
        <Route path="starred/item/:itemId" element={<ReaderApp />} />
        <Route path="folder/:folder" element={<ReaderApp />} />
        <Route path="folder/:folder/item/:itemId" element={<ReaderApp />} />
        <Route path="feed/:feedId" element={<ReaderApp />} />
        <Route path="feed/:feedId/item/:itemId" element={<ReaderApp />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listFeeds).mockResolvedValue([])
  vi.mocked(api.getCounts).mockResolvedValue(EMPTY_COUNTS)
  vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem()], 3))
  vi.mocked(api.setItemRead).mockResolvedValue(undefined)
  vi.mocked(api.setItemStar).mockResolvedValue(undefined)
  vi.mocked(api.markAllRead).mockResolvedValue(0)
})

const feedPath = `/feed/${encodeURIComponent(FEED_URL)}`

describe('ReaderApp — paged per-view fetch', () => {
  it('fetches the selected feed’s first page (page 1, newest, unknown total) on mount', async () => {
    renderAt(feedPath)
    await waitFor(() =>
      expect(api.listItems).toHaveBeenCalledWith(FEED_SEL, {
        page: 1,
        order: 'newest',
        total: null,
      }),
    )
    // The list renders the fetched page's items straight through (server-ordered).
    expect(await screen.findByText('First article')).toBeInTheDocument()
  })

  it('fetches unread/starred counts on mount', async () => {
    renderAt(feedPath)
    await waitFor(() => expect(api.getCounts).toHaveBeenCalled())
  })

  it('refetches the page when the reading order toggles (fetch effect is order-keyed)', async () => {
    renderAt(feedPath)
    // First fetch resolves and records total=3 for this selection.
    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(1))
    // The sort toggle lives in the list toolbar once there are items.
    fireEvent.click(await screen.findByRole('button', { name: /newest first/i }))
    // Toggling to oldest re-issues with the now-known total so itemsQuery can
    // mirror the request to the correct server page.
    await waitFor(() =>
      expect(api.listItems).toHaveBeenCalledWith(FEED_SEL, {
        page: 1,
        order: 'oldest',
        total: 3,
      }),
    )
  })

  it('marks the whole view read via the server primitive, then refetches the page and counts', async () => {
    renderAt(feedPath)
    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.getCounts).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole('button', { name: /mark all read/i }))
    // The server primitive is called with the current selection, not a per-guid fan-out.
    await waitFor(() => expect(api.markAllRead).toHaveBeenCalledWith(FEED_SEL))
    expect(api.setItemRead).not.toHaveBeenCalled()
    // reload() reconciles the visible page and badge counts after the server call resolves.
    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.getCounts).toHaveBeenCalledTimes(2))
  })

  it('refetches counts after an optimistic read write', async () => {
    renderAt(feedPath)
    await waitFor(() => expect(api.getCounts).toHaveBeenCalledTimes(1))
    // Opening the item auto-marks it read → persists → refreshes counts.
    fireEvent.click(await screen.findByText('First article'))
    await waitFor(() => expect(api.setItemRead).toHaveBeenCalledWith('g1', true))
    await waitFor(() => expect(api.getCounts).toHaveBeenCalledTimes(2))
  })
})
