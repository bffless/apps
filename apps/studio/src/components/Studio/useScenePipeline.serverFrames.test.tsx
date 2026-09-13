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
