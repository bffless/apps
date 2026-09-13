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
import studioReducer, { createProject, addSource, patchSource, patchSourceStage, selectActive, setScenes } from '../../store/studioSlice'
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
    imageSizeMock.mockImplementation(async (url: string) => {
      const n = (calls.get(url) ?? 0) + 1
      calls.set(url, n)
      return n === 1 ? { width: 0, height: 0 } : real
    })
    const store = makeStore()
    await runNext(store)
    await waitFor(() => expect(active(store).stageProgress.thumbnails?.status).toBe('done'), { timeout: 12000 })
    const sheets = active(store).contactSheets
    expect(sheets[0]).toMatchObject({ width: real.width, height: real.height, cellWidth: 1280, cellHeight: 720 })
    expect(calls.get(sheets[0].url!)).toBe(2)
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

  it('re-frames at full height and swaps the served url into the post', async () => {
    const store = makeStore()
    let pipe!: ReturnType<typeof useScenePipeline>
    render(
      <Provider store={store}>
        <BlogHarness onReady={(p) => (pipe = p)} />
      </Provider>,
    )
    let ok = false
    await act(async () => {
      ok = await pipe.reframeBlogImage('/api/uploads/blog/old.jpg', 42)
    })
    expect(ok).toBe(true)
  }, 15000)
})
