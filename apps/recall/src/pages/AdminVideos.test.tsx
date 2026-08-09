/**
 * TDD for the admin video list page (Task 5). Written first, against a page
 * that doesn't exist yet — expected to fail on import until `AdminVideos.tsx`
 * lands.
 *
 * Follows the pattern already established in `recallApi.test.ts` (and used by
 * sibling apps' RTK-backed tests): stub the global `fetch` directly rather than
 * MSW — neither Reader nor Studio use MSW for component-level network tests
 * (Studio's `msw` dependency is for its dev-mode mock bootstrap, not Vitest),
 * and recall doesn't have MSW wired up as a test dependency at all.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { recallApi } from '../store/recallApi'
import { AdminVideos } from './AdminVideos'

// fetchBaseQuery builds a `Request` from the relative `/api/...` URL; in
// jsdom+undici that needs an absolute base (mirrors recallApi.test.ts).
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

function renderPage() {
  const store = makeStore()
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/admin']}>
        <AdminVideos />
      </MemoryRouter>
    </Provider>,
  )
}

const VIDEOS = [
  {
    id: 'v1',
    title: 'Intro to Recall',
    description: null,
    youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    status: 'ready',
    duration: 125,
    source_path: null,
    audio_path: null,
    created_ms: 1_700_000_000_000,
    updated_ms: 1_700_000_000_000,
  },
  {
    id: 'v2',
    title: 'Deep dive',
    description: null,
    youtube_url: null,
    status: 'draft',
    duration: 0,
    source_path: null,
    audio_path: null,
    created_ms: 1_700_000_100_000,
    updated_ms: 1_700_000_100_000,
  },
]

function mockList() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ videos: VIDEOS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
}

describe('AdminVideos', () => {
  it('renders both video titles with their status pills', async () => {
    mockList()

    renderPage()

    expect(await screen.findByText('Intro to Recall')).toBeInTheDocument()
    expect(screen.getByText('Deep dive')).toBeInTheDocument()
    expect(screen.getByText('ready')).toBeInTheDocument()
    expect(screen.getByText('draft')).toBeInTheDocument()
    expect(screen.getAllByTestId('status-pill')).toHaveLength(2)
  })
})
