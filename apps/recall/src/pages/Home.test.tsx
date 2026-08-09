/**
 * Component tests for PR-feedback-6's Home page additions:
 * - search result cards link to the public video detail page (`/video/:id`)
 * - the search box and active tab sync to the URL (`?q=`, `?tab=`)
 *
 * Follows the fetch-stub pattern established in `AdminVideos.test.tsx`/
 * `AdminVideo.test.tsx` (stub global `fetch`, not MSW) and routes requests by
 * pathname/method. Uses `createMemoryRouter` + `RouterProvider` (rather than
 * a plain `<MemoryRouter>`) so tests can inspect `router.state.historyAction`
 * — the only way to actually verify "submitting pushes a new history entry,
 * switching tabs replaces" rather than just checking the resulting URL.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { recallApi } from '../store/recallApi'
import { Home } from './Home'

const ORIGIN = 'http://localhost:3000'
const RealRequest = globalThis.Request
class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) input = ORIGIN + input
    super(input, init)
  }
}
beforeAll(() => {
  globalThis.Request = BasedRequest as unknown as typeof Request
})
afterAll(() => {
  globalThis.Request = RealRequest
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function makeStore() {
  return configureStore({
    reducer: { [recallApi.reducerPath]: recallApi.reducer },
    middleware: (gdm) => gdm().concat(recallApi.middleware),
  })
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const SEARCH_VIDEO = {
  videoId: 'v1',
  title: 'Intro to Recall',
  youtubeId: 'dQw4w9WgXcQ',
  duration: 600,
  sheetUrl: null,
  sheetMeta: null,
  moments: [{ start: 12, snippet: 'hello world', similarity: 0.9 }],
}

/** Routes `POST /api/search`, `GET /api/videos` (library grid), and a
 * lenient catch-all for anything else (e.g. ChatTab's mount-time reads) so
 * tests only need to describe what they actually care about. */
function mockFetchRouter({
  searchVideos = [SEARCH_VIDEO],
}: {
  searchVideos?: typeof SEARCH_VIDEO[]
} = {}) {
  const searchFn = vi.fn(async () => jsonResponse({ videos: searchVideos }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      const { pathname } = new URL(request.url)
      if (pathname === '/api/search' && request.method === 'POST') return searchFn()
      if (pathname === '/api/videos' && request.method === 'GET') return jsonResponse({ videos: [] })
      return jsonResponse({})
    }),
  )
  return { searchFn }
}

function renderHome(initialEntries: string[] = ['/']) {
  const store = makeStore()
  const router = createMemoryRouter(
    [
      { path: '/', element: <Home /> },
      { path: '/video/:videoId', element: <div>Video detail page</div> },
    ],
    { initialEntries },
  )
  const utils = render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  )
  return { ...utils, router }
}

describe('Home — search result links to the video detail page', () => {
  it('wraps the thumbnail and title in a Link to /video/<videoId>', async () => {
    mockFetchRouter()
    renderHome()

    // Submit a search.
    const input = screen.getByLabelText('Search video transcripts')
    fireEvent.change(input, { target: { value: 'hugging face token' } })
    fireEvent.submit(input.closest('form')!)

    const title = await screen.findByRole('link', { name: 'Intro to Recall' })
    expect(title).toHaveAttribute('href', '/video/v1')

    const thumbLink = screen.getByRole('link', { name: '' }) // the thumbnail-only link has no accessible name
    expect(thumbLink).toHaveAttribute('href', '/video/v1')

    // The external YouTube link is untouched.
    expect(screen.getByRole('link', { name: /Watch on YouTube/ })).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    )
  })
})

describe('Home — URL state for search', () => {
  it('mounts and auto-runs a search when the page loads with ?q= already set', async () => {
    const { searchFn } = mockFetchRouter()
    renderHome(['/?q=hugging%20face'])

    await waitFor(() => expect(searchFn).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('link', { name: 'Intro to Recall' })).toBeInTheDocument()

    // The input reflects the URL's query too.
    expect(screen.getByLabelText('Search video transcripts')).toHaveValue('hugging face')
  })

  it('submitting a NEW search pushes ?q= as a fresh history entry', async () => {
    mockFetchRouter()
    const { router } = renderHome()

    const input = screen.getByLabelText('Search video transcripts')
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => expect(router.state.location.search).toBe('?q=hello'))
    expect(router.state.historyAction).toBe('PUSH')
  })

  it('switching tabs replaces (not pushes) and sets/clears ?tab=', async () => {
    mockFetchRouter()
    const { router } = renderHome()

    screen.getByRole('tab', { name: 'chat' }).click()
    await waitFor(() => expect(router.state.location.search).toBe('?tab=chat'))
    expect(router.state.historyAction).toBe('REPLACE')

    screen.getByRole('tab', { name: 'search' }).click()
    await waitFor(() => expect(router.state.location.search).toBe(''))
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('restores the chat tab on mount from ?tab=chat', () => {
    mockFetchRouter()
    renderHome(['/?tab=chat'])

    expect(screen.getByRole('tab', { name: 'chat' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'search' })).toHaveAttribute('aria-selected', 'false')
  })
})

describe('Home — repeat-seek bugfix (PR-feedback-6)', () => {
  it('clicking the same moment chip twice still remounts the player both times (real repro: identical seek used to be a no-op)', async () => {
    mockFetchRouter()
    renderHome()

    const input = screen.getByLabelText('Search video transcripts')
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.submit(input.closest('form')!)

    const momentButton = await screen.findByRole('button', { name: /hello world/ })

    fireEvent.click(momentButton)
    const firstIframe = await screen.findByTitle('Intro to Recall')
    expect(firstIframe).toBeInTheDocument()

    // Click the SAME moment again — identical {youtubeId, startSec}. Before
    // the nonce fix this was a silent no-op (unchanged remount key).
    fireEvent.click(momentButton)
    const secondIframe = await screen.findByTitle('Intro to Recall')
    expect(secondIframe).not.toBe(firstIframe) // a genuinely new DOM node
  })
})
