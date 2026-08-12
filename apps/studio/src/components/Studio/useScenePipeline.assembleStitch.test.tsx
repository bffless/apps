/**
 * `assembleSceneRemote` + `stitchFinalCutRemote` (story: server-video-ops, task
 * 7). Mounts the real `useScenePipeline` hook against a real store + MSW, same
 * style as `useScenePipeline.videoBackend.test.tsx` (task 6) — reuses its
 * `Request` shim via `../../test/mswRequestShim` rather than duplicating it.
 *
 * Both functions THROW on failure (the assemble/stitch regime — see
 * `useAutoBuild.test.tsx` for the halt-detection consumer); every case here
 * asserts against the rejected/resolved promise directly rather than a
 * swallowed `sceneErrors` entry.
 *
 * The guard-clause cases (no clip, fully-cut scene, an unassembled scene) throw
 * BEFORE any network call, so they run instantly — only one happy-path case per
 * function pays for the mock job store's real pending→running→done spin
 * (~4-6s wall time, matching task 6's budget).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
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

// Load the real MSW studio handlers (VITE_MOCK_STUDIO gates them in — see
// mocks/handlers.test.ts for the same stub-env-then-import pattern).
vi.stubEnv('VITE_MOCK_STUDIO', 'true')
const { handlers } = await import('../../mocks/handlers')
const server = setupServer(...handlers)

import { useScenePipeline } from './useScenePipeline'

type Store = ReturnType<typeof makeStore>
type Pipe = ReturnType<typeof useScenePipeline>

function makeStore(scenes: Scene[]) {
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
  store.dispatch(setScenes(scenes))
  return store
}

const stateOf = (store: Store) => store.getState() as unknown as Parameters<typeof selectActive>[0]
const sceneOf = (store: Store, id: string) => selectActive(stateOf(store)).scenes.find((s) => s.id === id)
const finalCutUrlOf = (store: Store) => selectActive(stateOf(store)).finalCutUrl

/** A scene cut, with its own clip, ready to assemble. */
function withClip(id: string, index: number, cuts: { start: number; end: number }[] = []): Scene {
  return {
    id,
    index,
    sourceId: 'src1',
    title: `Scene ${index + 1}`,
    start: index * 10,
    end: index * 10 + 10,
    transcript: 'hello world',
    status: 'pending',
    clipUrl: `/api/uploads/projects/p1/scene-clip/${id}.mp4`,
    clipAudioUrl: `/api/uploads/projects/p1/audio/${id}.wav`,
    cuts,
  }
}

/** Mounts the real hook and hands the whole pipe out via a ref-like callback,
 *  so the test can call `assembleSceneRemote`/`stitchFinalCutRemote` directly
 *  and assert on the returned/rejected promise — unlike `sliceScene`, these
 *  THROW, so a bare button-click harness (task 6's pattern) would leave an
 *  unhandled rejection. */
function Harness({ onPipe }: { onPipe: (pipe: Pipe) => void }) {
  const pipe = useScenePipeline()
  onPipe(pipe)
  return null
}

function mount(store: Store): { pipe: Pipe } {
  let captured: Pipe | null = null
  render(
    <Provider store={store}>
      <Harness onPipe={(p) => (captured = p)} />
    </Provider>,
  )
  return { get pipe() { return captured! } }
}

installMswRelativeUrlShim()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => {
  server.close()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  window.localStorage.clear()
  window.localStorage.setItem('videoBackend', 'server')
  resetVideoBackendForTests()
})

describe('assembleSceneRemote', () => {
  it('throws before enqueueing when the scene has no clip', async () => {
    const store = makeStore([{ ...withClip('s1', 0), clipUrl: undefined }])
    const { pipe } = mount(store)

    await expect(pipe.assembleSceneRemote('s1')).rejects.toThrow(/cut this scene first/i)
    expect(sceneOf(store, 's1')?.assembledUrl).toBeUndefined()
  })

  it('throws before enqueueing when every span is cut (plan.video is empty)', async () => {
    // Cuts covering the whole [0, 10) scene span — nothing left to render.
    const store = makeStore([withClip('s1', 0, [{ start: 0, end: 10 }])])
    const { pipe } = mount(store)

    await expect(pipe.assembleSceneRemote('s1')).rejects.toThrow(/nothing to assemble/i)
    expect(sceneOf(store, 's1')?.assembledUrl).toBeUndefined()
  })

  it(
    'renders via /api/video/slice + polls the job, patching assembledUrl and status built',
    async () => {
      const store = makeStore([withClip('s1', 0)])
      const { pipe } = mount(store)

      const result = pipe.assembleSceneRemote('s1')
      await waitFor(
        () => {
          expect(sceneOf(store, 's1')?.assembledUrl).toMatch(
            /^\/api\/uploads\/projects\/p1\/scene-clip\/server\//,
          )
        },
        { timeout: 8000 },
      )
      await expect(result).resolves.toBeUndefined()
      expect(sceneOf(store, 's1')?.status).toBe('built')
    },
    10000,
  )
})

describe('stitchFinalCutRemote', () => {
  it('throws before enqueueing when a scene is not yet assembled', async () => {
    const store = makeStore([{ ...withClip('s1', 0), assembledUrl: 'a.mp4' }, withClip('s2', 1)])
    const { pipe } = mount(store)

    await expect(pipe.stitchFinalCutRemote()).rejects.toThrow(/isn.t assembled yet/i)
    expect(finalCutUrlOf(store)).toBeNull()
  })

  it(
    'stitches a SINGLE scene via /api/video/concat (no shortcut) and mints a fresh export URL',
    async () => {
      // Observable-behavior parity with the wasm path: assembleFinalCutBlob's
      // one-scene shortcut only skips the ffmpeg concat pass — the resulting
      // Blob still goes through saveFinalCut's re-upload, which is a NEW url,
      // never an alias of assembledUrl. videoConcatStart with one part
      // reproduces that: finalCutUrl must differ from the scene's assembledUrl.
      const store = makeStore([
        { ...withClip('s1', 0), assembledUrl: '/api/uploads/projects/p1/export/scene-s1.mp4' },
      ])
      const { pipe } = mount(store)

      const result = pipe.stitchFinalCutRemote()
      await waitFor(
        () => {
          expect(finalCutUrlOf(store)).toMatch(/^\/api\/uploads\/projects\/p1\/export\/server\//)
        },
        { timeout: 8000 },
      )
      await expect(result).resolves.toBeUndefined()
      expect(finalCutUrlOf(store)).not.toBe(sceneOf(store, 's1')?.assembledUrl)
    },
    10000,
  )
})

describe('server error contracts', () => {
  it('throws with the job error message when the slice job fails', async () => {
    server.use(
      http.post('/api/video/slice', () => HttpResponse.json({ jobId: 'slice-fail', status: 'pending' })),
      http.get('/api/studio/job', ({ request }) => {
        const id = new URL(request.url).searchParams.get('id')
        if (id !== 'slice-fail') return HttpResponse.json({ status: 'error', kind: 'video-slice', error: 'unknown job' })
        return HttpResponse.json({ status: 'error', kind: 'video-slice', error: 'ffmpeg exited 1' })
      }),
    )
    const store = makeStore([withClip('s1', 0)])
    const { pipe } = mount(store)

    await expect(pipe.assembleSceneRemote('s1')).rejects.toThrow(/ffmpeg exited 1/)
    expect(sceneOf(store, 's1')?.assembledUrl).toBeUndefined()
  })
})
