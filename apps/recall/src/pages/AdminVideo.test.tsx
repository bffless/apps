/**
 * Component tests for the admin video detail page's PR-feedback-1 additions:
 * the signed-URL source-video player and the transcript panel. Follows the
 * fetch-stub pattern established in `AdminVideos.test.tsx` (stub global
 * `fetch`, not MSW — recall doesn't wire MSW into Vitest) — extended here to
 * ROUTE by pathname/method since this page hits two endpoints
 * (`GET /api/videos/get`, `POST /api/uploads/sign`) instead of one.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { configureStore } from '@reduxjs/toolkit'
import { recallApi } from '../store/recallApi'
import { AdminVideo, FramesGrid } from './AdminVideo'

// fetchBaseQuery builds a `Request` from the relative `/api/...` URL; in
// jsdom+undici that needs an absolute base (mirrors AdminVideos.test.tsx).
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

function renderPage(videoId: string) {
  const store = makeStore()
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/admin/video/${videoId}`]}>
        <Routes>
          <Route path="admin/video/:videoId" element={<AdminVideo />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  )
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const WORDS = [
  { text: 'Hello', start: 0, end: 0.4 },
  { text: 'world.', start: 0.4, end: 0.9 },
  { text: 'Second', start: 3, end: 3.3 },
  { text: 'sentence.', start: 3.3, end: 3.8 },
]

function baseVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    title: 'Intro to Recall',
    description: null,
    youtube_url: null,
    status: 'draft',
    duration: 0,
    source_path: null,
    audio_path: null,
    sheet_path: null,
    sheet_meta: null,
    transcript: null,
    created_ms: 1_700_000_000_000,
    updated_ms: 1_700_000_000_000,
    ...overrides,
  }
}

/** Routes `GET /api/videos/get` and `POST /api/uploads/sign` by pathname/method. */
function mockFetchRouter({
  video,
  signedUrl = 'https://storage.example.com/videos/v1/source/clip.mp4?sig=abc',
}: {
  video: ReturnType<typeof baseVideo>
  signedUrl?: string
}) {
  const signFn = vi.fn(async (request: Request) => {
    void request // consumed by the caller via `signFn.mock.calls`
    return jsonResponse({ url: signedUrl, expiresIn: 3600 })
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      const { pathname } = new URL(request.url)
      if (pathname === '/api/videos/get' && request.method === 'GET') {
        return jsonResponse({ video })
      }
      if (pathname === '/api/uploads/sign' && request.method === 'POST') {
        return signFn(request)
      }
      throw new Error(`Unhandled fetch in test: ${request.method} ${request.url}`)
    }),
  )
  return { signFn }
}

describe('AdminVideo', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders a signed-URL source video player when source_path is set, not the bare dropzone', async () => {
    const video = baseVideo({ status: 'draft', source_path: '/api/uploads/videos/v1/source/clip.mp4' })
    const { signFn } = mockFetchRouter({ video })

    renderPage('v1')

    expect(await screen.findByDisplayValue('Intro to Recall')).toBeInTheDocument()

    // The signed player renders once /api/uploads/sign resolves.
    const player = await screen.findByTestId('source-video-player')
    expect(player).toHaveAttribute(
      'src',
      'https://storage.example.com/videos/v1/source/clip.mp4?sig=abc',
    )

    // The sign request was sent WITHOUT a leading slash on the key.
    const [signedRequest] = signFn.mock.calls[0] as [Request]
    const body = (await signedRequest.clone().json()) as { url: string }
    expect(body.url).toBe('api/uploads/videos/v1/source/clip.mp4')

    // Confirmation, not a context-free dropzone: "Uploaded ✓" and a "Replace
    // video" affordance, no "Drop a video file here" prompt.
    expect(screen.getByText('Uploaded ✓')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace video' })).toBeInTheDocument()
    expect(screen.queryByText(/Drop a video file here/)).not.toBeInTheDocument()
  })

  it('shows the dropzone (not a player) when there is no source_path yet', async () => {
    const video = baseVideo()
    mockFetchRouter({ video })

    renderPage('v1')

    expect(await screen.findByText(/Drop a video file here/)).toBeInTheDocument()
    expect(screen.queryByTestId('source-video-player')).not.toBeInTheDocument()
  })

  it('renders the transcript panel (word count + clickable spans) when transcript is set', async () => {
    const video = baseVideo({
      status: 'transcribed',
      duration: 4,
      transcript: JSON.stringify({ words: WORDS, text: 'Hello world. Second sentence.' }),
    })
    mockFetchRouter({ video })

    renderPage('v1')

    expect(await screen.findByRole('heading', { name: 'Transcript' })).toBeInTheDocument()
    expect(screen.getByText(`${WORDS.length} words · 0:04`)).toBeInTheDocument()
    expect(screen.getAllByTestId('transcript-span').length).toBeGreaterThan(0)

    // Task 3: the stage pill reflects the persisted transcribed state, not a
    // bare "Idle".
    expect(screen.getByText(`Transcribed ✓ · ${WORDS.length} words · 0:04`)).toBeInTheDocument()
  })

  it('renders neither the transcript panel nor the player when the video is untouched', async () => {
    const video = baseVideo()
    mockFetchRouter({ video })

    renderPage('v1')

    await screen.findByDisplayValue('Intro to Recall')
    expect(screen.queryByRole('heading', { name: 'Transcript' })).not.toBeInTheDocument()
    expect(screen.getByText('Idle')).toBeInTheDocument()
  })

  it('shows a "Generate frames" backfill button once a source video exists but has no sheet yet', async () => {
    const video = baseVideo({ status: 'draft', source_path: '/api/uploads/videos/v1/source/clip.mp4' })
    mockFetchRouter({ video })

    renderPage('v1')

    expect(await screen.findByRole('button', { name: 'Generate frames' })).toBeInTheDocument()
  })

  it('shows no frames affordance at all before any source video is uploaded', async () => {
    const video = baseVideo()
    mockFetchRouter({ video })

    renderPage('v1')

    await screen.findByDisplayValue('Intro to Recall')
    expect(screen.queryByRole('button', { name: 'Generate frames' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Frames ✓/)).not.toBeInTheDocument()
  })

  it('shows a "Frames ✓ · N tiles" pill instead of the button once a sheet exists', async () => {
    const meta = { cols: 5, rows: 2, tileW: 320, tileH: 180, tiles: Array.from({ length: 10 }, (_, i) => ({ t: i })) }
    const video = baseVideo({
      status: 'draft',
      source_path: '/api/uploads/videos/v1/source/clip.mp4',
      sheet_path: '/api/uploads/sheets/v1/x.jpg',
      sheet_meta: JSON.stringify(meta),
    })
    mockFetchRouter({ video })

    renderPage('v1')

    expect(await screen.findByText('Frames ✓ · 10 tiles')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generate frames' })).not.toBeInTheDocument()
  })
})

describe('FramesGrid', () => {
  const META = {
    cols: 5,
    rows: 2,
    tileW: 320,
    tileH: 180,
    tiles: Array.from({ length: 10 }, (_, i) => ({ t: i * 6 })),
  }

  function renderGrid(video: ReturnType<typeof baseVideo>, onSeek = vi.fn()) {
    mockFetchRouter({ video })
    render(
      <Provider store={makeStore()}>
        <FramesGrid videoId="v1" video={video} onSeek={onSeek} />
      </Provider>,
    )
    return { onSeek }
  }

  it('renders nothing when the video has no sheet yet', () => {
    const video = baseVideo()
    mockFetchRouter({ video })
    const { container } = render(
      <Provider store={makeStore()}>
        <FramesGrid videoId="v1" video={video} onSeek={vi.fn()} />
      </Provider>,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('renders all 10 tiles with mm:ss captions when the sheet is present', () => {
    const video = baseVideo({
      sheet_path: '/api/uploads/sheets/v1/x.jpg',
      sheet_meta: JSON.stringify(META),
    })
    renderGrid(video)

    expect(screen.getByRole('heading', { name: 'Frames' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument()
    const tiles = screen.getAllByRole('button', { name: /^0:\d{2}$/ })
    expect(tiles).toHaveLength(10)
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(screen.getByText('0:54')).toBeInTheDocument() // tile 9, t=54
  })

  it("clicking a tile seeks to that tile's own timestamp", () => {
    const video = baseVideo({
      sheet_path: '/api/uploads/sheets/v1/x.jpg',
      sheet_meta: JSON.stringify(META),
    })
    const { onSeek } = renderGrid(video)

    const tiles = screen.getAllByRole('button', { name: /^0:\d{2}$/ })
    tiles[3].click() // tile index 3 -> t = 3 * 6 = 18
    expect(onSeek).toHaveBeenCalledWith(18)

    tiles[7].click() // tile index 7 -> t = 7 * 6 = 42
    expect(onSeek).toHaveBeenCalledWith(42)
  })

  // PR-feedback-6: v2 (multi-sheet) metadata.
  const META_V2 = {
    v: 2,
    cols: 6,
    rows: 5,
    tileW: 320,
    tileH: 180,
    sheets: [
      {
        url: '/api/uploads/sheets/v1/sheet-0.jpg',
        tiles: Array.from({ length: 30 }, (_, i) => ({ t: i * 10 })),
      },
      {
        url: '/api/uploads/sheets/v1/sheet-1.jpg',
        tiles: Array.from({ length: 5 }, (_, i) => ({ t: 300 + i * 10 })),
      },
    ],
  }

  it('v2: renders every tile across every sheet', () => {
    const video = baseVideo({
      sheet_path: META_V2.sheets[0].url,
      sheet_meta: JSON.stringify(META_V2),
    })
    renderGrid(video)

    const tiles = screen.getAllByRole('button', { name: /^\d+:\d{2}$/ })
    expect(tiles).toHaveLength(35) // 30 + 5
    expect(screen.getByText('0:00')).toBeInTheDocument() // sheet 0, tile 0
    expect(screen.getByText('5:40')).toBeInTheDocument() // sheet 1, last tile: t=340
  })

  it("v2: clicking a tile from the SECOND sheet still seeks to that tile's own timestamp", () => {
    const video = baseVideo({
      sheet_path: META_V2.sheets[0].url,
      sheet_meta: JSON.stringify(META_V2),
    })
    const { onSeek } = renderGrid(video)

    // Sheet 1's tiles render after sheet 0's 30 tiles; its 2nd tile is t=310.
    const tiles = screen.getAllByRole('button', { name: /^\d+:\d{2}$/ })
    tiles[31].click()
    expect(onSeek).toHaveBeenCalledWith(310)
  })

  // PR-feedback-7: a hidden (`display:none`) per-sheet warmer `<img
  // loading="lazy">` gated a `background-image` behind its `onLoad` — but a
  // `display:none` element has no layout box, so whether/when the browser
  // ever fires that lazy `load` at all is undefined (this was the live
  // first-load bug: tiles blank, zero network requests, forever, until a
  // fresh page load). Fixed by rendering each tile as its own real, VISIBLE
  // `<img loading="lazy">` (absolutely positioned/cropped inside its frame)
  // instead — no warmer, no gate, no event to wait for. These specs pin
  // that every tile's own `<img>` is present with the right `src`/
  // `loading="lazy"` the instant the grid renders, with no dispatched event
  // of any kind.
  it("v2: each sheet's tiles render their own real <img loading=\"lazy\"> cropped from that sheet's url immediately, with no load/intersection event", () => {
    const video = baseVideo({
      sheet_path: META_V2.sheets[0].url,
      sheet_meta: JSON.stringify(META_V2),
    })
    renderGrid(video)

    const tiles = screen.getAllByRole('button', { name: /^\d+:\d{2}$/ })
    const firstTileImg = tiles[0].querySelector('img') as HTMLImageElement
    const secondSheetTileImg = tiles[30].querySelector('img') as HTMLImageElement

    expect(firstTileImg).toHaveAttribute('src', META_V2.sheets[0].url)
    expect(firstTileImg).toHaveAttribute('loading', 'lazy')
    expect(secondSheetTileImg).toHaveAttribute('src', META_V2.sheets[1].url)
    expect(secondSheetTileImg).toHaveAttribute('loading', 'lazy')

    // Every tile across both sheets gets a real, lazy-loadable <img> — 30 +
    // 5 = 35, one per tile, not one warmer per sheet.
    const images = document.querySelectorAll('img[loading="lazy"]')
    expect(images).toHaveLength(35)
  })

  it('v1: falls back to sheet_path as the (only) sheet url, on every tile\'s own <img>', () => {
    const video = baseVideo({
      sheet_path: '/api/uploads/sheets/v1/x.jpg',
      sheet_meta: JSON.stringify(META),
    })
    renderGrid(video)

    const images = document.querySelectorAll('img[loading="lazy"]')
    expect(images).toHaveLength(10) // one per tile, all sharing the v1 sheet's url
    images.forEach((img) => expect(img).toHaveAttribute('src', '/api/uploads/sheets/v1/x.jpg'))
  })

  it('post-generation transition: sheets added via a prop update on an ALREADY-MOUNTED grid render tiles immediately, no remount and no event required', () => {
    const store = makeStore()
    const withoutSheet = baseVideo()
    mockFetchRouter({ video: withoutSheet })

    const { rerender } = render(
      <Provider store={store}>
        <FramesGrid videoId="v1" video={withoutSheet} onSeek={vi.fn()} />
      </Provider>,
    )

    // No sheet yet: FramesGrid renders nothing (same component instance,
    // just no output).
    expect(screen.queryByRole('button', { name: /^\d+:\d{2}$/ })).not.toBeInTheDocument()

    // Simulates what a live "Generate frames" completion does: the SAME
    // mounted component gets a re-render with a fresh `video` prop that now
    // carries sheet data (RTK Query cache update / invalidation-refetch),
    // not a fresh mount of the page.
    const withSheet = baseVideo({
      sheet_path: META_V2.sheets[0].url,
      sheet_meta: JSON.stringify(META_V2),
    })
    rerender(
      <Provider store={store}>
        <FramesGrid videoId="v1" video={withSheet} onSeek={vi.fn()} />
      </Provider>,
    )

    const tiles = screen.getAllByRole('button', { name: /^\d+:\d{2}$/ })
    expect(tiles).toHaveLength(35)
    const firstTileImg = tiles[0].querySelector('img') as HTMLImageElement
    expect(firstTileImg).toHaveAttribute('src', META_V2.sheets[0].url)
    expect(firstTileImg).toHaveAttribute('loading', 'lazy')
  })
})
