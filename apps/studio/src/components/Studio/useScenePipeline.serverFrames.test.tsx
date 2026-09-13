/**
 * Server frames: prep contact sheets, per-scene sheets, and the blog re-frame
 * helpers go through /api/video/{contact-sheet,frames} (MSW) and never touch
 * the browser capture path. Mirrors useScenePipeline.serverExtract.test.tsx.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import studioReducer, {
  createProject,
  addSource,
  patchSource,
  patchSourceStage,
  selectActive,
  setBlogResult,
  setBlogRunning,
  setScenes,
} from '../../store/studioSlice'
import { studioApi } from '../../store/studioApi'
import { PER_VIDEO_STAGES } from '../../lib/pipeline'
import { resetVideoBackendForTests } from '../../lib/videoBackend'
import { installMswRelativeUrlShim } from '../../test/mswRequestShim'
import type { Scene } from '../../lib/scenes'

const { imageSizeMock } = vi.hoisted(() => ({ imageSizeMock: vi.fn() }))
vi.mock('../../lib/imageSize', () => ({ imageSize: imageSizeMock }))

vi.stubEnv('VITE_MOCK_STUDIO', 'true')
const { handlers } = await import('../../mocks/handlers')
const server = setupServer(...handlers)

import { useScenePipeline } from './useScenePipeline'

type Store = ReturnType<typeof makeStore>

function makeStore() {
  const store = configureStore({
    reducer: { studio: studioReducer, [studioApi.reducerPath]: studioApi.reducer },
    middleware: (g) => g().concat(studioApi.middleware),
  })
  store.dispatch(createProject({ id: 'p1', now: 1 }))
  store.dispatch(addSource({ id: 'src1', fileName: 'rec.mov', duration: 1101 }))
  store.dispatch(
    patchSource({ id: 'src1', patch: { sourceUrl: '/api/uploads/projects/p1/source/rec.mov', duration: 1101 } }),
  )
  for (const stage of PER_VIDEO_STAGES) {
    store.dispatch(patchSourceStage({ id: 'src1', stage, patch: { status: 'done' } }))
  }
  return store
}

const stateOf = (store: Store) => store.getState() as unknown as Parameters<typeof selectActive>[0]
const active = (store: Store) => selectActive(stateOf(store))

function Harness() {
  const pipe = useScenePipeline()
  return (
    <button onClick={() => void pipe.next({ file: new File([], 'x'), src: '', duration: 0 })}>next</button>
  )
}

async function runNext(store: Store) {
  render(
    <Provider store={store}>
      <Harness />
    </Provider>,
  )
  await act(async () => {
    screen.getByText('next').click()
  })
}

installMswRelativeUrlShim()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  server.events.removeAllListeners()
})
afterAll(() => server.close())
beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  resetVideoBackendForTests()
  imageSizeMock.mockResolvedValue({ width: 3 * 1280 + 8, height: 4 * 720 + 10 })
})

describe('prep contact sheets on the server', () => {
  it('asks /api/video/contact-sheet for the planned frames and stores url-only sheets', async () => {
    const seen: { times: number[]; labels: string[] }[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/video/contact-sheet') seen.push(await request.clone().json())
    })
    const store = makeStore()
    await runNext(store)

    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('done'), { timeout: 12000 })

    expect(seen).toHaveLength(1)
    expect(seen[0].times).toHaveLength(120)
    expect(seen[0].labels[0]).toMatch(/^\d+:\d{2}$/)
    const sheets = active(store).contactSheets
    expect(sheets).toHaveLength(10)
    expect(sheets.every((s) => s.dataUrl === '' && s.url?.startsWith('/api/uploads/projects/p1/thumbnails/server/'))).toBe(true)
    expect(sheets[0]).toMatchObject({ cols: 3, rows: 4, cellWidth: 1280, cellHeight: 720, count: 12, index: 0, total: 10 })
    expect(active(store).stageProgress.thumbnails?.detail).toBe('120 frames · 10 sheets (server)')
  }, 15000)

  it('re-measures a sheet whose image size failed to load, once', async () => {
    const real = { width: 3 * 1280 + 8, height: 4 * 720 + 10 }
    const calls = new Map<string, number>()
    const firstAt = new Map<string, number>()
    const secondAt = new Map<string, number>()
    imageSizeMock.mockImplementation(async (url: string) => {
      const n = (calls.get(url) ?? 0) + 1
      calls.set(url, n)
      ;(n === 1 ? firstAt : secondAt).set(url, Date.now())
      return n === 1 ? { width: 0, height: 0 } : real
    })
    const store = makeStore()
    await runNext(store)
    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('done'), { timeout: 12000 })
    const sheets = active(store).contactSheets
    expect(sheets[0]).toMatchObject({ width: real.width, height: real.height, cellWidth: 1280, cellHeight: 720 })
    expect(calls.get(sheets[0].url!)).toBe(2)
    // waits a beat before the re-measure, instead of re-reading a URL that just failed
    expect(secondAt.get(sheets[0].url!)! - firstAt.get(sheets[0].url!)!).toBeGreaterThanOrEqual(950)
  }, 15000)

  it('retries a failed sheet job once without the last minute of the recording', async () => {
    const bodies: { times: number[]; labels: string[] }[] = []
    server.use(
      http.post('/api/video/contact-sheet', async ({ request }) => {
        bodies.push((await request.clone().json()) as { times: number[]; labels: string[] })
        return bodies.length === 1 ? HttpResponse.json({ jobId: 'tail-fail', status: 'pending' }) : undefined
      }),
      http.get('/api/studio/job', ({ request }) =>
        new URL(request.url).searchParams.get('id') === 'tail-fail'
          ? HttpResponse.json({ status: 'error', kind: 'video-contact-sheet', error: 'Server contact sheets failed' })
          : undefined,
      ),
    )
    const store = makeStore()
    await runNext(store)
    await waitFor(() => expect(['done', 'error']).toContain(active(store).stageProgress.thumbnails?.status), { timeout: 12000 })

    expect(active(store).stageProgress.thumbnails?.status).toBe('done')
    expect(active(store).contactSheets.length).toBeGreaterThan(0)
    expect(bodies).toHaveLength(2)
    expect(Math.max(...bodies[0].times)).toBeGreaterThanOrEqual(1101 - 60)
    expect(Math.max(...bodies[1].times)).toBeLessThan(1101 - 60)
    expect(bodies[1].labels).toHaveLength(bodies[1].times.length)
  }, 15000)

  it('keeps the sheets from recordings that succeed and names the one it skipped', async () => {
    server.use(
      http.post('/api/video/contact-sheet', async ({ request }) => {
        const body = (await request.clone().json()) as { sourceUrl: string }
        return body.sourceUrl.includes('second.mov') ? HttpResponse.json({ jobId: 'always-fail', status: 'pending' }) : undefined
      }),
      http.get('/api/studio/job', ({ request }) =>
        new URL(request.url).searchParams.get('id') === 'always-fail'
          ? HttpResponse.json({ status: 'error', kind: 'video-contact-sheet', error: 'Server contact sheets failed' })
          : undefined,
      ),
    )
    const store = makeStore()
    store.dispatch(addSource({ id: 'src2', fileName: 'second.mov', duration: 600 }))
    store.dispatch(
      patchSource({ id: 'src2', patch: { sourceUrl: '/api/uploads/projects/p1/source/second.mov', duration: 600 } }),
    )
    for (const stage of PER_VIDEO_STAGES) {
      store.dispatch(patchSourceStage({ id: 'src2', stage, patch: { status: 'done' } }))
    }
    await runNext(store)
    await waitFor(() => expect(['done', 'error']).toContain(active(store).stageProgress.thumbnails?.status), { timeout: 12000 })

    expect(active(store).stageProgress.thumbnails?.status).toBe('done')
    expect(active(store).contactSheets.length).toBeGreaterThan(0)
    expect(active(store).contactSheets.every((s) => Math.max(...s.times) < 1101)).toBe(true)
    expect(active(store).stageProgress.thumbnails?.detail).toContain('skipped second.mov')
  }, 15000)

  it("stores a later recording's sheets at global times, offset by the recordings before it", async () => {
    const bodies: { sourceUrl: string; times: number[] }[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/video/contact-sheet') bodies.push(await request.clone().json())
    })
    const store = makeStore()
    store.dispatch(addSource({ id: 'src2', fileName: 'second.mov', duration: 600 }))
    store.dispatch(
      patchSource({ id: 'src2', patch: { sourceUrl: '/api/uploads/projects/p1/source/second.mov', duration: 600 } }),
    )
    for (const stage of PER_VIDEO_STAGES) {
      store.dispatch(patchSourceStage({ id: 'src2', stage, patch: { status: 'done' } }))
    }
    await runNext(store)
    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('done'), { timeout: 12000 })

    const second = bodies.find((b) => b.sourceUrl.includes('second.mov'))!
    expect(second.times.length).toBeGreaterThan(0)
    expect(Math.max(...second.times)).toBeLessThan(600) // sent at local times
    const stored = active(store)
      .contactSheets.flatMap((s) => s.times)
      .filter((t) => t >= 1101)
    expect(stored).toHaveLength(second.times.length)
    stored.forEach((t, i) => expect(t).toBeCloseTo(second.times[i] + 1101, 6))
  }, 15000)

  it('maps sheets onto the planned times in order when none of the times CE echoes match', async () => {
    let asked: number[] = []
    server.use(
      http.post('/api/video/contact-sheet', async ({ request }) => {
        asked = ((await request.clone().json()) as { times: number[] }).times
        return HttpResponse.json({ jobId: 'sheets-perturbed', status: 'pending' })
      }),
      http.get('/api/studio/job', ({ request }) => {
        if (new URL(request.url).searchParams.get('id') !== 'sheets-perturbed') return undefined
        const sheets = Array.from({ length: Math.ceil(asked.length / 12) }, (_, i) => ({
          url: `/api/uploads/projects/p1/thumbnails/server/p/sheet-${i}.jpg`,
          times: asked.slice(i * 12, i * 12 + 12).map((t) => t + 0.001),
          cols: 3,
          rows: 4,
          bytes: 1,
        }))
        return HttpResponse.json({ status: 'done', kind: 'video-contact-sheet', result: { sheets, drawn: true } })
      }),
    )
    const store = makeStore()
    await runNext(store)
    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('done'), { timeout: 12000 })
    expect(asked.length).toBeGreaterThan(0)
    expect(active(store).contactSheets.flatMap((s) => s.times)).toEqual(asked)
  }, 15000)

  it('says so in the detail when CE could not draw the sheet timestamps', async () => {
    let asked: number[] = []
    server.use(
      http.post('/api/video/contact-sheet', async ({ request }) => {
        asked = ((await request.clone().json()) as { times: number[] }).times
        return HttpResponse.json({ jobId: 'sheets-undrawn', status: 'pending' })
      }),
      http.get('/api/studio/job', ({ request }) => {
        if (new URL(request.url).searchParams.get('id') !== 'sheets-undrawn') return undefined
        const sheets = [{ url: '/api/uploads/projects/p1/thumbnails/server/n/sheet-01.jpg', times: asked.slice(0, 12), cols: 3, rows: 4, bytes: 1 }]
        return HttpResponse.json({ status: 'done', kind: 'video-contact-sheet', result: { sheets, drawn: false } })
      }),
    )
    const store = makeStore()
    await runNext(store)
    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('done'), { timeout: 12000 })
    expect(active(store).stageProgress.thumbnails?.detail).toContain('timestamps not drawn')
  }, 15000)

  it('names an 11th recording the per-recording budget left with no sheet, instead of silently dropping it', async () => {
    const store = makeStore()
    store.dispatch(patchSource({ id: 'src1', patch: { duration: 600 } }))
    let lastId = 'src1'
    for (let i = 2; i <= 11; i++) {
      const id = `src${i}`
      lastId = id
      store.dispatch(addSource({ id, fileName: `rec${i}.mov`, duration: 600 }))
      store.dispatch(
        patchSource({ id, patch: { sourceUrl: `/api/uploads/projects/p1/source/rec${i}.mov`, duration: 600 } }),
      )
      for (const stage of PER_VIDEO_STAGES) {
        store.dispatch(patchSourceStage({ id, stage, patch: { status: 'done' } }))
      }
    }
    await runNext(store)
    // 11 recordings each round-trip their own /api/video/contact-sheet job
    // sequentially (pending → running → done, POLL_INTERVAL_MS apart), so this
    // takes noticeably longer than the 1-2 recording tests above.
    await waitFor(() => expect(['done', 'error']).toContain(active(store).stageProgress.thumbnails?.status), {
      timeout: 90000,
    })

    expect(active(store).stageProgress.thumbnails?.status).toBe('done')
    const sheets = active(store).contactSheets
    expect(sheets.length).toBeLessThanOrEqual(10)
    // The 11th (last-added, equal-length) recording is the one the per-recording
    // budget gives no sheet to (ties go to the earlier recording).
    expect(active(store).stageProgress.thumbnails?.detail).toContain(`no sheet left for rec${lastId.slice(3)}.mov`)
  }, 95000)

  it('drops sheets past the director\'s image limit as defense in depth', async () => {
    server.use(
      http.post('/api/video/contact-sheet', () => HttpResponse.json({ jobId: 'clamp-many', status: 'pending' })),
      http.get('/api/studio/job', ({ request }) => {
        if (new URL(request.url).searchParams.get('id') !== 'clamp-many') return undefined
        const sheets = Array.from({ length: 11 }, (_, i) => ({
          url: `/api/uploads/projects/p1/thumbnails/server/clamp/sheet-${String(i + 1).padStart(2, '0')}.jpg`,
          times: Array.from({ length: 12 }, (_, j) => i * 12 + j),
          cols: 3,
          rows: 4,
          bytes: 1,
        }))
        return HttpResponse.json({ status: 'done', kind: 'video-contact-sheet', result: { sheets, drawn: true } })
      }),
    )
    const store = makeStore()
    await runNext(store)
    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('done'), { timeout: 12000 })

    const sheets = active(store).contactSheets
    expect(sheets).toHaveLength(10)
    expect(sheets.every((s) => s.total === 10)).toBe(true)
    expect(active(store).stageProgress.thumbnails?.detail).toContain('dropped 1 sheet')
  }, 15000)

  it('fails the stage, instead of passing it, when the job returns no sheets', async () => {
    server.use(
      http.post('/api/video/contact-sheet', () => HttpResponse.json({ jobId: 'empty-sheets', status: 'pending' })),
      http.get('/api/studio/job', () => HttpResponse.json({ status: 'done', kind: 'video-contact-sheet', result: { sheets: [] } })),
    )
    const store = makeStore()
    await runNext(store)
    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('error'), { timeout: 12000 })
    expect(active(store).stageProgress.thumbnails?.detail).toMatch(/without any sheets/)
    expect(active(store).contactSheets).toEqual([])
  }, 15000)
})

function SheetsHarness({ id }: { id: string }) {
  const pipe = useScenePipeline()
  return <button onClick={() => void pipe.generateSceneSheets(id)}>sheets</button>
}

describe('per-scene sheets on the server', () => {
  it('grabs the scene window through /api/video/contact-sheet and patches url-only sheets', async () => {
    const bodies: { times: number[]; labels: string[] }[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/video/contact-sheet') bodies.push(await request.clone().json())
    })
    const store = makeStore()
    store.dispatch(
      setScenes([
        {
          id: 'sc1',
          index: 0,
          sourceId: 'src1',
          title: 'Intro',
          start: 60,
          end: 90,
          transcript: '',
          status: 'pending',
          cuts: [],
        } as Scene,
      ]),
    )
    render(
      <Provider store={store}>
        <SheetsHarness id="sc1" />
      </Provider>,
    )
    await act(async () => {
      screen.getByText('sheets').click()
    })
    await waitFor(() => expect(active(store).scenes[0].sheets?.length ?? 0).toBeGreaterThan(0), { timeout: 12000 })
    expect(bodies[0].times[0]).toBeGreaterThanOrEqual(60)
    expect(bodies[0].times.at(-1)!).toBeLessThan(90)
    expect(bodies[0].labels[0]).toBe('1:00')
    expect(active(store).scenes[0].sheets!.every((s) => s.url?.includes('/thumbnails/server/'))).toBe(true)
  }, 15000)
})

function BlogHarness({ onReady }: { onReady: (p: ReturnType<typeof useScenePipeline>) => void }) {
  const pipe = useScenePipeline()
  onReady(pipe)
  return null
}

describe('blog re-frame on the server', () => {
  it('fetches the candidate strip as server frames and reuses them as previews', async () => {
    const heights: number[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/video/frames') heights.push((await request.clone().json()).height)
    })
    const store = makeStore()
    let pipe!: ReturnType<typeof useScenePipeline>
    render(
      <Provider store={store}>
        <BlogHarness onReady={(p) => (pipe = p)} />
      </Provider>,
    )
    let strip: { time: number; thumb: string }[] = []
    await act(async () => {
      strip = await pipe.captureBlogSiblings(300)
    })
    expect(strip.length).toBeGreaterThan(0)
    expect(strip.every((s) => s.thumb.startsWith('/api/uploads/projects/p1/frames/server/'))).toBe(true)
    expect(heights).toEqual([720])

    let preview = ''
    await act(async () => {
      preview = await pipe.captureBlogPreview(strip[1].time)
    })
    expect(preview).toBe(strip[1].thumb)
    expect(heights).toEqual([720]) // cached: no second job
  }, 15000)

  it('matches frames back by time, so a dropped frame never shifts the others', async () => {
    // The frames job answers for every requested time except the second, and
    // names each url after its time so a mismatch is visible.
    let asked: number[] = []
    server.use(
      http.post('/api/video/frames', async ({ request }) => {
        asked = ((await request.clone().json()) as { times: number[] }).times
        return HttpResponse.json({ jobId: 'drop-one', status: 'pending' })
      }),
      http.get('/api/studio/job', ({ request }) => {
        if (new URL(request.url).searchParams.get('id') !== 'drop-one') return undefined
        const frames = asked.filter((_, i) => i !== 1).map((time) => ({ time, url: `/api/uploads/projects/p1/frames/server/t-${time}.jpg` }))
        return HttpResponse.json({ status: 'done', kind: 'video-frames', result: { frames } })
      }),
    )
    const store = makeStore()
    let pipe!: ReturnType<typeof useScenePipeline>
    render(
      <Provider store={store}>
        <BlogHarness onReady={(p) => (pipe = p)} />
      </Provider>,
    )
    let strip: { time: number; thumb: string }[] = []
    await act(async () => {
      strip = await pipe.captureBlogSiblings(300)
    })
    expect(asked.length).toBeGreaterThan(2)
    expect(strip).toHaveLength(asked.length - 1)
    expect(strip.map((s) => s.time)).not.toContain(asked[1])
    for (const s of strip) expect(s.thumb).toBe(`/api/uploads/projects/p1/frames/server/t-${s.time}.jpg`)
  }, 15000)

  it('falls back to request order when no frame time CE echoes matches the request', async () => {
    let asked: number[] = []
    server.use(
      http.post('/api/video/frames', async ({ request }) => {
        asked = ((await request.clone().json()) as { times: number[] }).times
        return HttpResponse.json({ jobId: 'frames-perturbed', status: 'pending' })
      }),
      http.get('/api/studio/job', ({ request }) => {
        if (new URL(request.url).searchParams.get('id') !== 'frames-perturbed') return undefined
        const frames = asked.map((time, i) => ({ time: time + 0.001, url: `/api/uploads/projects/p1/frames/server/i-${i}.jpg` }))
        return HttpResponse.json({ status: 'done', kind: 'video-frames', result: { frames } })
      }),
    )
    const store = makeStore()
    let pipe!: ReturnType<typeof useScenePipeline>
    render(
      <Provider store={store}>
        <BlogHarness onReady={(p) => (pipe = p)} />
      </Provider>,
    )
    let strip: { time: number; thumb: string }[] = []
    await act(async () => {
      strip = await pipe.captureBlogSiblings(300)
    })
    expect(asked.length).toBeGreaterThan(1)
    expect(strip.map((s) => s.thumb)).toEqual(asked.map((_, i) => `/api/uploads/projects/p1/frames/server/i-${i}.jpg`))
  }, 15000)

  it('re-frames at full height and swaps the served url into the post', async () => {
    const heights: number[] = []
    server.events.on('request:start', async ({ request }) => {
      if (new URL(request.url).pathname === '/api/video/frames') heights.push((await request.clone().json()).height)
    })
    const store = makeStore()
    const oldUrl = '/api/uploads/blog/old.jpg'
    store.dispatch(setBlogRunning({ direction: '', script: '', jobId: 'blog-1' }))
    store.dispatch(setBlogResult({ markdown: `Intro\n\n![A frame](${oldUrl})\n`, frames: [{ url: oldUrl, time: 40 }] }))
    let pipe!: ReturnType<typeof useScenePipeline>
    render(
      <Provider store={store}>
        <BlogHarness onReady={(p) => (pipe = p)} />
      </Provider>,
    )
    let ok = false
    await act(async () => {
      ok = await pipe.reframeBlogImage(oldUrl, 42)
    })
    expect(ok).toBe(true)
    expect(heights).toEqual([1080])
    const blog = active(store).blog!
    expect(blog.markdown).not.toContain(oldUrl)
    expect(blog.markdown).toMatch(/!\[A frame\]\(\/api\/uploads\/projects\/p1\/frames\/server\/[^)]+\)/)
    expect(blog.frames).toEqual([{ url: expect.stringContaining('/frames/server/'), time: 42 }])
  }, 15000)
})
