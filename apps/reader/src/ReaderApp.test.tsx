import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ReaderApp } from './ReaderApp'
import * as api from './lib/api'
import type { Item } from './lib/items'
import type { Feed } from './lib/feeds'
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
    enclosureType: null,
    read: false,
    starred: false,
    archived: false,
    fetchedAt: 1,
    ...overrides,
  }
}

function makePage(items: Item[], total = items.length): ItemsPage {
  return { items, total, page: 1, pageSize: 20, totalPages: Math.max(1, Math.ceil(total / 20)) }
}

function makeFeed(overrides: Partial<Feed> = {}): Feed {
  return {
    url: FEED_URL,
    title: 'Example Feed',
    siteUrl: null,
    folder: null,
    iconUrl: null,
    lastFetchedAt: null,
    lastError: null,
    addedAt: null,
    ...overrides,
  }
}

// Counts consistent with the default page (the feed has unread items): the
// mark-all-read button is now gated on server counts, not a loaded-page scan.
const FEED_COUNTS: Counts = { unreadByFeed: { [FEED_URL]: 3 }, starred: 0, unreadStarred: 0 }

/** Mirror the App.tsx route table, rendering ReaderApp for each navigable view. */
function renderAt(path: string, props: Parameters<typeof ReaderApp>[0] = {}) {
  const el = <ReaderApp {...props} />
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route index element={el} />
        <Route path="item/:itemId" element={el} />
        <Route path="all" element={el} />
        <Route path="all/item/:itemId" element={el} />
        <Route path="starred" element={el} />
        <Route path="starred/item/:itemId" element={el} />
        <Route path="folder/:folder" element={el} />
        <Route path="folder/:folder/item/:itemId" element={el} />
        <Route path="feed/:feedId" element={el} />
        <Route path="feed/:feedId/item/:itemId" element={el} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listFeeds).mockResolvedValue([])
  vi.mocked(api.getCounts).mockResolvedValue(FEED_COUNTS)
  vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem()], 3))
  vi.mocked(api.getItem).mockResolvedValue(null)
  vi.mocked(api.setItemRead).mockResolvedValue(undefined)
  vi.mocked(api.setItemStar).mockResolvedValue(undefined)
  vi.mocked(api.setFeedFolder).mockResolvedValue(undefined)
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

  it('does NOT refetch the list page when opening an item', async () => {
    // Opening an item is a navigation (adds /item/:id, keeps ?page) but the
    // selection/page/order are unchanged — the loaded page already holds the
    // item, so the page fetch must not re-run. Regression guard: the fetch
    // effect must not be re-triggered merely because react-router's `navigate`
    // identity changes on navigation.
    renderAt(feedPath)
    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByText('First article'))
    // The article opens (auto-mark-read fires)…
    await waitFor(() => expect(api.setItemRead).toHaveBeenCalledWith('g1', true))
    // …but the list page is NOT refetched.
    expect(api.listItems).toHaveBeenCalledTimes(1)
  })
})

describe('ReaderApp — deep-link getItem fallback', () => {
  it('resolves an item off the current page via api.getItem and renders it', async () => {
    // The loaded page holds g1; the deep-linked guid is NOT in it.
    vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem({ guid: 'g1' })], 3))
    vi.mocked(api.getItem).mockResolvedValue(
      makeItem({ guid: 'OFFPAGE', title: 'Off page article', content: '<p>off page body</p>', read: true }),
    )
    renderAt(`${feedPath}/item/OFFPAGE`)
    // The guid absent from the page triggers a getItem fetch for it.
    await waitFor(() => expect(api.getItem).toHaveBeenCalledWith('OFFPAGE'))
    // The fetched item renders in the reading pane (title + body).
    expect(await screen.findByRole('heading', { name: /Off page article/i })).toBeInTheDocument()
    expect(await screen.findByText('off page body')).toBeInTheDocument()
  })

  it('does not spin forever when getItem resolves null (unknown/deleted guid)', async () => {
    vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem({ guid: 'g1' })], 3))
    vi.mocked(api.getItem).mockResolvedValue(null)
    renderAt(`${feedPath}/item/GHOST`)
    await waitFor(() => expect(api.getItem).toHaveBeenCalledWith('GHOST'))
    // With no item resolved, the loading state clears and the view falls back to
    // the list rather than spinning indefinitely.
    expect(await screen.findByText('First article')).toBeInTheDocument()
  })

  it('does not call getItem when opening an item already on the loaded page', async () => {
    // Opening from the list (page already loaded, item present) resolves from the
    // page — no by-guid fetch fires; getItem is only the off-page fallback.
    vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem({ guid: 'g1' })], 3))
    renderAt(feedPath)
    fireEvent.click(await screen.findByText('First article'))
    await waitFor(() => expect(screen.getByRole('heading', { name: /First article/i })).toBeInTheDocument())
    expect(api.getItem).not.toHaveBeenCalled()
  })
})

describe('ReaderApp — empty / all-caught-up states', () => {
  it('shows the “all caught up” message when the view total is 0', async () => {
    vi.mocked(api.listItems).mockResolvedValue(makePage([], 0))
    renderAt(feedPath)
    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument()
  })

  it('does not show the caught-up message for an empty out-of-range page (total > 0)', async () => {
    // Page is empty but the view has items (total 5) — an out-of-range page, not
    // an empty view, so the misleading "all caught up" message must NOT appear.
    vi.mocked(api.listItems).mockResolvedValue({ items: [], total: 5, page: 2, pageSize: 20, totalPages: 1 })
    renderAt(feedPath)
    await waitFor(() => expect(api.listItems).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument())
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument()
  })
})

describe('ReaderApp — out-of-range page clamp', () => {
  it('clamps an out-of-range ?page to the last valid page and renders it', async () => {
    // First fetch (for the stale ?page=3) returns an empty out-of-range page: no
    // items, but total>0 and totalPages<page — the stranding case the clamp fixes.
    vi.mocked(api.listItems).mockResolvedValueOnce({
      items: [],
      total: 5,
      page: 3,
      pageSize: 20,
      totalPages: 1,
    })
    // The default beforeEach mock (a normal page-1 page) serves the clamped refetch.
    renderAt(`${feedPath}?page=3`)
    // The client re-issues the fetch for the clamped last page (page 1), not page 3.
    await waitFor(() =>
      expect(api.listItems).toHaveBeenCalledWith(FEED_SEL, { page: 1, order: 'newest', total: null }),
    )
    // The valid last page renders — not the empty out-of-range page and not the
    // misleading caught-up state.
    expect(await screen.findByText('First article')).toBeInTheDocument()
    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument()
  })

  it('preserves an open /item/:id when clamping an out-of-range ?page', async () => {
    // A deep link to an off-page item on a stale ?page: the first fetch is the
    // empty out-of-range page; the clamp must keep the /item/OFFPAGE segment so
    // the open article survives (not drop back to the bare view path).
    vi.mocked(api.listItems).mockResolvedValueOnce({
      items: [],
      total: 5,
      page: 3,
      pageSize: 20,
      totalPages: 1,
    })
    vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem({ guid: 'g1' })], 3))
    vi.mocked(api.getItem).mockResolvedValue(
      makeItem({ guid: 'OFFPAGE', title: 'Off page article', content: '<p>off page body</p>', read: true }),
    )
    renderAt(`${feedPath}/item/OFFPAGE?page=3`)
    // The clamp re-issues the page fetch for the last valid page (page 1).
    await waitFor(() =>
      expect(api.listItems).toHaveBeenCalledWith(FEED_SEL, { page: 1, order: 'newest', total: null }),
    )
    // The open item survives the clamp: the article is still rendered afterwards
    // (a clamp to the bare view path would have closed it).
    expect(await screen.findByRole('heading', { name: /Off page article/i })).toBeInTheDocument()
  })
})

describe('ReaderApp — mark-all-read gating on counts', () => {
  it('shows the button when the loaded page is all-read but counts say the view has unread', async () => {
    // Loaded page is entirely read, yet the feed's unread count is > 0 (unread on
    // another page). The button is gated on counts, so it must still show.
    vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem({ guid: 'g1', read: true })], 3))
    vi.mocked(api.getCounts).mockResolvedValue({ unreadByFeed: { [FEED_URL]: 2 }, starred: 0, unreadStarred: 0 })
    renderAt(feedPath)
    expect(await screen.findByRole('button', { name: /mark all read/i })).toBeInTheDocument()
  })

  it('hides the button when counts report the view has no unread', async () => {
    vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem({ guid: 'g1', read: true })], 3))
    vi.mocked(api.getCounts).mockResolvedValue({ unreadByFeed: { [FEED_URL]: 0 }, starred: 0, unreadStarred: 0 })
    renderAt(feedPath)
    await waitFor(() => expect(api.getCounts).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /mark all read/i })).not.toBeInTheDocument()
  })
})

describe('ReaderApp — oldest-first unknown-total re-issue (#164)', () => {
  it('re-issues the oldest-first fetch once total is known after a refresh clears it', async () => {
    // The subtlest fetch-effect branch: an oldest-first fetch with an UNKNOWN
    // total falls back to the newest server page, then re-issues once `total` is
    // known. It only fires when sortOrder==='oldest' AND totalRef===null.
    const KNOWN_TOTAL = 45
    // A feed so the sidebar's "Refresh now" button is enabled.
    vi.mocked(api.listFeeds).mockResolvedValue([makeFeed()])
    // Every page resolves a real positive total so the re-issue (result.total>0) fires.
    vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem()], KNOWN_TOTAL))
    vi.mocked(api.refresh).mockResolvedValue({ inserted: 0, skipped: 0, errors: 0 })

    // Open the drawer so the sidebar "Refresh now" control is reachable.
    renderAt(feedPath, { drawerOpen: true })

    // Initial fetch: newest, unknown total. Records total=45 for this selection.
    await waitFor(() =>
      expect(api.listItems).toHaveBeenCalledWith(FEED_SEL, { page: 1, order: 'newest', total: null }),
    )

    // Toggle to oldest. total is already KNOWN here, so this is a single fetch
    // with total=45 — NOT the path under test, just the setup to make oldest active.
    fireEvent.click(await screen.findByRole('button', { name: /newest first/i }))
    await waitFor(() =>
      expect(api.listItems).toHaveBeenCalledWith(FEED_SEL, { page: 1, order: 'oldest', total: KNOWN_TOTAL }),
    )

    // Refresh clears totalRef (reload()). The ensuing refetch now runs with
    // sortOrder==='oldest' AND totalRef===null → the unknown-total path: a
    // fallback fetch with total:null, then a re-issue once the response's total
    // (45) is known.
    fireEvent.click(await screen.findByRole('button', { name: /refresh now/i }))
    await waitFor(() => expect(api.refresh).toHaveBeenCalled())

    // The null→N re-issue: first the oldest fetch with unknown total…
    await waitFor(() =>
      expect(api.listItems).toHaveBeenCalledWith(FEED_SEL, { page: 1, order: 'oldest', total: null }),
    )
    // …then the corrected re-issue with the now-known total. Prove it's the
    // RE-ISSUE (not the earlier toggle's oldest+45 call) by asserting an oldest
    // fetch with total:null is immediately followed by one with total:KNOWN_TOTAL
    // in the oldest-only call subsequence.
    await waitFor(() => {
      const oldestTotals = vi
        .mocked(api.listItems)
        .mock.calls.filter(([, opts]) => opts?.order === 'oldest')
        .map(([, opts]) => opts?.total)
      const nullIdx = oldestTotals.indexOf(null)
      expect(nullIdx).toBeGreaterThanOrEqual(0)
      expect(oldestTotals[nullIdx + 1]).toBe(KNOWN_TOTAL)
    })
  })
})

describe('ReaderApp — refetch folder page after moving a feed in/out of it (#161)', () => {
  const NEWS_PATH = '/folder/News'

  it('refetches the item page when a feed is moved OUT of the folder being viewed', async () => {
    // Viewing folder "News" with a feed in it. The item page is server-scoped to
    // that folder's membership, so moving the feed out must refetch it — the
    // sidebar badge regroups client-side but the fetched page would go stale.
    vi.mocked(api.listFeeds).mockResolvedValue([makeFeed({ folder: 'News' })])
    // Open the nav drawer so the sidebar (with the move-folder select) is in the
    // accessibility tree in the mobile single-pane branch jsdom renders.
    renderAt(NEWS_PATH, { drawerOpen: true })
    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(1))
    // Move the feed to Uncategorized (the " none" sentinel value) → out of "News".
    const select = await screen.findByLabelText(/move example feed to a folder/i)
    fireEvent.change(select, { target: { value: ' none' } })
    // The move persists…
    await waitFor(() => expect(api.setFeedFolder).toHaveBeenCalled())
    // …and reload() re-issues the folder page fetch (case-insensitive match on
    // the viewed folder's old membership).
    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(2))
  })

  it('does NOT refetch when the move does not involve the folder being viewed', async () => {
    // Viewing folder "News", but the feed lives in "Tech". Moving it out of Tech
    // touches neither the old nor the new = the viewed folder, so the item page
    // membership is unchanged and must not refetch.
    vi.mocked(api.listFeeds).mockResolvedValue([makeFeed({ folder: 'Tech' })])
    renderAt(NEWS_PATH, { drawerOpen: true })
    await waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(1))
    const select = await screen.findByLabelText(/move example feed to a folder/i)
    fireEvent.change(select, { target: { value: ' none' } })
    await waitFor(() => expect(api.setFeedFolder).toHaveBeenCalled())
    // No extra page fetch: the move is unrelated to the "News" view.
    expect(api.listItems).toHaveBeenCalledTimes(1)
  })
})

describe('ReaderApp — starred mark-all-read gating on unreadStarred (#163)', () => {
  it('shows the button in the starred view when unreadStarred > 0', async () => {
    // The starred view's mark-all-read is gated on the server `unreadStarred`
    // count (unread AND starred), not a loaded-page scan.
    vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem({ guid: 'g1', starred: true, read: false })], 3))
    vi.mocked(api.getCounts).mockResolvedValue({ unreadByFeed: {}, starred: 5, unreadStarred: 2 })
    renderAt('/starred')
    expect(await screen.findByRole('button', { name: /mark all read/i })).toBeInTheDocument()
  })

  it('hides the button in the starred view when unreadStarred is 0 even if the loaded page has an unread row', async () => {
    // Loaded page holds an unread starred row, but the server reports no
    // unread-among-starred — the button is gated on the count, so it must hide.
    vi.mocked(api.listItems).mockResolvedValue(makePage([makeItem({ guid: 'g1', starred: true, read: false })], 3))
    vi.mocked(api.getCounts).mockResolvedValue({ unreadByFeed: {}, starred: 5, unreadStarred: 0 })
    renderAt('/starred')
    await waitFor(() => expect(api.getCounts).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /mark all read/i })).not.toBeInTheDocument()
  })
})
