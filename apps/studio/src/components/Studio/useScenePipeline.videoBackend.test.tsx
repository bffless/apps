/**
 * `sliceScene`'s video-backend branch (story: server-video-ops, task 6). Mounts
 * the real `useScenePipeline` hook against a real store + MSW (mirroring
 * `useAutoBuild.test.tsx`'s "mount the real hook" style), so the assertions are
 * about what the producer actually gets: which network calls fire, and what
 * lands on the scene. Only the wasm/WebAudio leaves (`ffmpegSlice`,
 * `buildSliceCommand`, `sliceAudioWav`) are mocked — jsdom has neither a wasm
 * ffmpeg core nor Web Audio, the same reason `useAutoBuild.test.tsx` mocks
 * `assembleSceneBlob` instead of running the real renderer.
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
  setScenes,
  selectActive,
} from '../../store/studioSlice'
import { studioApi } from '../../store/studioApi'
import type { Scene } from '../../lib/scenes'
import { resetVideoBackendForTests } from '../../lib/videoBackend'
import { installMswRelativeUrlShim } from '../../test/mswRequestShim'

const { ffmpegSliceMock, buildSliceCommandMock, sliceAudioWavMock } = vi.hoisted(() => ({
  ffmpegSliceMock: vi.fn(),
  buildSliceCommandMock: vi.fn(),
  sliceAudioWavMock: vi.fn(),
}))

vi.mock('../../lib/export/ffmpeg', () => ({
  slice: ffmpegSliceMock,
  sliceSourcePath: () => 'input.mp4',
}))
vi.mock('../../lib/export/slice', () => ({
  buildSliceCommand: buildSliceCommandMock,
}))
vi.mock('../../lib/audio', () => ({
  extractAudio: vi.fn(),
  deadSpaceFromUrl: vi.fn(),
  sliceAudioWav: sliceAudioWavMock,
}))

// Load the real MSW studio handlers (VITE_MOCK_STUDIO gates them in — see
// mocks/handlers.test.ts for the same stub-env-then-import pattern).
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
  store.dispatch(addSource({ id: 'src1', fileName: 'rec.mp4', duration: 30 }))
  store.dispatch(
    patchSource({
      id: 'src1',
      patch: { sourceUrl: '/api/uploads/projects/p1/source/rec.mp4', audioUrl: '/api/uploads/projects/p1/audio/rec.wav' },
    }),
  )
  const scene: Scene = {
    id: 's1',
    index: 0,
    sourceId: 'src1',
    title: 'Scene 1',
    start: 0,
    end: 5,
    transcript: 'hello world',
    status: 'pending',
  }
  store.dispatch(setScenes([scene]))
  return store
}

const stateOf = (store: Store) => store.getState() as unknown as Parameters<typeof selectActive>[0]
const sceneOf = (store: Store) => selectActive(stateOf(store)).scenes.find((s) => s.id === 's1')

/** Mounts the real hook and exposes just enough to drive + observe `sliceScene`. */
function Harness() {
  const { sliceScene, sceneErrors } = useScenePipeline()
  return (
    <div>
      <span data-testid="error">{sceneErrors['s1'] ?? ''}</span>
      <button onClick={() => void sliceScene('s1')}>cut</button>
    </div>
  )
}

async function cut() {
  await act(async () => {
    screen.getByText('cut').click()
  })
}

installMswRelativeUrlShim()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => {
  server.close()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  resetVideoBackendForTests()
  ffmpegSliceMock.mockResolvedValue(new Blob(['clip'], { type: 'video/mp4' }))
  buildSliceCommandMock.mockReturnValue(['ffmpeg', '-i', 'input.mp4', 'scene-0.mp4'])
  sliceAudioWavMock.mockResolvedValue(new Blob(['wav'], { type: 'audio/wav' }))
})

describe('sliceScene — server backend', () => {
  it(
    'cuts via /api/video/slice + polls the job, patching clipUrl AND clipAudioUrl',
    async () => {
      window.localStorage.setItem('videoBackend', 'server')
      const store = makeStore()
      render(
        <Provider store={store}>
          <Harness />
        </Provider>,
      )

      await cut()
      // The mock job store spins pending → running → done over 3 polls at
      // POLL_INTERVAL_MS (2s) apart — real delays, so this genuinely takes a
      // few seconds; give waitFor (and the test) enough room.
      await waitFor(
        () => {
          const scene = sceneOf(store)
          expect(scene?.clipUrl).toMatch(/^\/api\/uploads\/projects\/p1\/scene-clip\/server\//)
          expect(scene?.clipAudioUrl).toMatch(/^\/api\/uploads\/projects\/p1\/audio\/server\//)
        },
        { timeout: 8000 },
      )
      expect(screen.getByTestId('error').textContent).toBe('')

      // The wasm path never ran.
      expect(ffmpegSliceMock).not.toHaveBeenCalled()
      expect(sliceAudioWavMock).not.toHaveBeenCalled()
    },
    10000,
  )

  it('throws into sceneErrors when the server job finishes without a soundtrack WAV', async () => {
    window.localStorage.setItem('videoBackend', 'server')
    // Override the mock rule for this one case: `wantAudio` is honored but we
    // simulate a job result that dropped the WAV, exercising the defensive
    // `!out.audioUrl` guard the brief calls out.
    server.use(
      http.post('/api/video/slice', () =>
        HttpResponse.json({ jobId: 'no-audio-job', status: 'pending' }),
      ),
      http.get('/api/studio/job', ({ request }) => {
        const id = new URL(request.url).searchParams.get('id')
        if (id !== 'no-audio-job') return HttpResponse.json({ status: 'error', kind: 'video-slice', error: 'unknown job' })
        return HttpResponse.json({
          status: 'done',
          kind: 'video-slice',
          result: { url: '/api/uploads/projects/p1/scene-clip/server/x.mp4' },
        })
      }),
    )
    const store = makeStore()
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )

    await cut()
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toContain('soundtrack'),
    )
    expect(sceneOf(store)?.clipUrl).toBeUndefined()
  })
})

describe('sliceScene — wasm backend (unchanged path)', () => {
  it('still cuts via ffmpeg.wasm + WebAudio when the backend resolves to wasm', async () => {
    window.localStorage.setItem('videoBackend', 'wasm')
    // The wasm path fetches the raw source + audio bytes straight off
    // `/api/uploads/...` (no seeded objectStore entry needed — any bytes do,
    // since ffmpegSlice/sliceAudioWav are mocked and never inspect them).
    server.use(http.get('/api/uploads/*', () => new HttpResponse(new Uint8Array([1, 2, 3]).buffer)))

    const store = makeStore()
    render(
      <Provider store={store}>
        <Harness />
      </Provider>,
    )

    await cut()
    await waitFor(() => expect(sceneOf(store)?.clipUrl).toBeTruthy())

    expect(ffmpegSliceMock).toHaveBeenCalledTimes(1)
    expect(sliceAudioWavMock).toHaveBeenCalledTimes(1)
    expect(sceneOf(store)?.clipUrl).toMatch(/^\/api\/uploads\/projects\/p1\/scene-clip\/mock\//)
    expect(sceneOf(store)?.clipAudioUrl).toMatch(/^\/api\/uploads\/projects\/p1\/audio\/mock\//)
  })
})
