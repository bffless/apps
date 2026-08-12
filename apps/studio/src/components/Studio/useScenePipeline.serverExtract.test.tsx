/**
 * `processSource`'s extract-stage video-backend branch (story: server-video-ops,
 * task 8). Mounts the real `useScenePipeline` hook against a real store + MSW,
 * mirroring `useScenePipeline.videoBackend.test.tsx`'s (task 6) style: the
 * assertions are about what the producer actually gets — which network calls
 * fire, and what lands on the source. Only `lib/audio`'s WebAudio-backed
 * functions are mocked (jsdom has no Web Audio); the presigned upload +
 * fire-and-poll job flow all run for real through MSW.
 *
 * `extractAndUploadAudio` (the legacy single-source seam, ~useScenePipeline.ts:865)
 * is deliberately NOT covered here: it's dead code under the current
 * `currentStageId` routing (see the comment on that function) and this task
 * left it on the WebAudio path — see task-8-report.md for the data-flow
 * evidence.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { setupServer } from 'msw/node'
import studioReducer, { createProject, addSource, selectActive } from '../../store/studioSlice'
import { studioApi } from '../../store/studioApi'
import { resetVideoBackendForTests } from '../../lib/videoBackend'
import { installMswRelativeUrlShim } from '../../test/mswRequestShim'

const { extractAudioMock, peaksFromUrlMock, deadSpaceFromUrlMock, sliceAudioWavMock } = vi.hoisted(() => ({
  extractAudioMock: vi.fn(),
  peaksFromUrlMock: vi.fn(),
  deadSpaceFromUrlMock: vi.fn(),
  sliceAudioWavMock: vi.fn(),
}))

vi.mock('../../lib/audio', () => ({
  extractAudio: extractAudioMock,
  peaksFromUrl: peaksFromUrlMock,
  deadSpaceFromUrl: deadSpaceFromUrlMock,
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
  store.dispatch(addSource({ id: 'src1', fileName: 'rec.mp4', duration: 0 }))
  return store
}

const stateOf = (store: Store) => store.getState() as unknown as Parameters<typeof selectActive>[0]
const sourceOf = (store: Store) => selectActive(stateOf(store)).sources.find((s) => s.id === 'src1')
const stageOf = (store: Store) => selectActive(stateOf(store)).stageProgress

/** Mounts the real hook and exposes just enough to drive `processSource`. */
function Harness({ file }: { file: File }) {
  const { processSource } = useScenePipeline()
  return (
    <div>
      <button onClick={() => void processSource('src1', file)}>process</button>
    </div>
  )
}

async function process(file: File) {
  const store = makeStore()
  render(
    <Provider store={store}>
      <Harness file={file} />
    </Provider>,
  )
  await act(async () => {
    screen.getByText('process').click()
  })
  return store
}

installMswRelativeUrlShim()

// jsdom's <video> never fires `loadedmetadata` OR `error` (no media pipeline at
// all — see CutEditor.test.tsx's own note on this), so `measureVideoDuration`
// (the first await in `processSource`) would hang forever un-patched. Firing
// `error` synchronously off the `src` setter resolves it to duration 0, which
// this test doesn't assert on anyway.
let originalSrcDescriptor: PropertyDescriptor | undefined
beforeAll(() => {
  originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    set(value: string) {
      this.setAttribute('src', value)
      queueMicrotask(() => this.dispatchEvent(new Event('error')))
    },
    get() {
      return this.getAttribute('src') ?? ''
    },
  })
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => server.resetHandlers())
afterAll(() => {
  server.close()
  if (originalSrcDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'src', originalSrcDescriptor)
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  resetVideoBackendForTests()
  extractAudioMock.mockResolvedValue({
    wav: new Blob(['wav'], { type: 'audio/wav' }),
    peaks: [0.1, 0.2],
    deadSpace: [{ start: 1, end: 2 }],
  })
  peaksFromUrlMock.mockResolvedValue([0.5, 0.6, 0.7])
  deadSpaceFromUrlMock.mockResolvedValue([{ start: 3, end: 4 }])
})

describe('processSource extract stage — server backend', () => {
  it(
    'extracts via /api/video/extract-audio + polls the job, deriving peaks/deadSpace from the WAV url',
    async () => {
      window.localStorage.setItem('videoBackend', 'server')
      const file = new File([new Uint8Array([1, 2, 3])], 'rec.mp4', { type: 'video/mp4' })
      const store = await process(file)

      // Wait for the WHOLE `processSource` run to finish (through transcribe),
      // not just the extract write — `stepInFlight` is a module-level guard
      // shared across tests, so a still-running background poll here would
      // silently no-op the next test's `processSource` call.
      await waitFor(
        () => {
          const src = sourceOf(store)
          expect(src?.stageProgress.transcribe?.status).toBe('done')
        },
        { timeout: 12000 },
      )

      const src = sourceOf(store)
      expect(src?.audioUrl).toMatch(/^\/api\/uploads\/projects\/p1\/audio\/server\//)
      expect(src?.audioPeaks).toEqual([0.5, 0.6, 0.7])
      expect(src?.deadSpace).toEqual([{ start: 3, end: 4 }])
      expect(src?.stageProgress.extract).toEqual({ status: 'done', detail: '16 kHz mono WAV (server)' })

      // Primary-source dual-write into the legacy top-level fields.
      const active = selectActive(stateOf(store))
      expect(active.audioUrl).toBe(src?.audioUrl)
      expect(active.audioPeaks).toEqual([0.5, 0.6, 0.7])
      expect(active.deadSpace).toEqual([{ start: 3, end: 4 }])
      expect(stageOf(store).extract).toEqual({ status: 'done', detail: '16 kHz mono WAV (server)' })

      // The browser never decoded the source: the WebAudio extract path never ran,
      // only the two url-derived helpers, off the server's WAV url (not a File).
      expect(extractAudioMock).not.toHaveBeenCalled()
      expect(peaksFromUrlMock).toHaveBeenCalledWith(src?.audioUrl)
      expect(deadSpaceFromUrlMock).toHaveBeenCalledWith(src?.audioUrl)
    },
    15000,
  )
})

describe('processSource extract stage — wasm backend (unchanged path)', () => {
  it(
    'still extracts in-browser via extractAudio + uploads the WAV when the backend resolves to wasm',
    async () => {
      window.localStorage.setItem('videoBackend', 'wasm')
      const file = new File([new Uint8Array([1, 2, 3])], 'rec.mp4', { type: 'video/mp4' })
      const store = await process(file)

      // Same rationale as the server-branch test: wait for the full run
      // (through transcribe) so the module-level `stepInFlight` guard is clear
      // before any later test's `processSource` call.
      await waitFor(
        () => {
          const src = sourceOf(store)
          expect(src?.stageProgress.transcribe?.status).toBe('done')
        },
        { timeout: 12000 },
      )

      const src = sourceOf(store)
      expect(src?.audioUrl).toMatch(/^\/api\/uploads\/projects\/p1\/audio\/mock\//)
      expect(src?.audioPeaks).toEqual([0.1, 0.2])
      expect(src?.deadSpace).toEqual([{ start: 1, end: 2 }])
      expect(src?.stageProgress.extract?.status).toBe('done')
      expect(src?.stageProgress.extract?.detail).toMatch(/^16 kHz mono WAV · /)

      expect(extractAudioMock).toHaveBeenCalledTimes(1)
      expect(peaksFromUrlMock).not.toHaveBeenCalled()
      expect(deadSpaceFromUrlMock).not.toHaveBeenCalled()
    },
    15000,
  )
})
