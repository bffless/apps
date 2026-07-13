/**
 * Auto Build orchestrator — the halted-then-fixed-by-hand paths (issue #220).
 *
 * Mounts the real hook against a real store, so the assertions are about the
 * behaviour the producer actually sees: what the board says after a halt, and
 * what Resume does (or doesn't) re-run. The ffmpeg render and the upload are the
 * only mocks — everything between them is the shipped code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import { Provider, useDispatch, useSelector } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import studioReducer, {
  createProject,
  setScenes,
  patchScene,
  setFinalCutUrl,
  selectActive,
} from '../../store/studioSlice'
import { studioApi } from '../../store/studioApi'
import type { Scene } from '../../lib/scenes'
import type { ContactSheet } from '../../lib/frames'

const { assembleSceneBlobMock, assembleFinalCutBlobMock } = vi.hoisted(() => ({
  assembleSceneBlobMock: vi.fn(),
  assembleFinalCutBlobMock: vi.fn(),
}))

vi.mock('../../lib/export/assembleScene', () => ({
  assembleSceneBlob: assembleSceneBlobMock,
  assembleFinalCutBlob: assembleFinalCutBlobMock,
}))

// The runner only uses this to hand bytes to the (mocked) render.
vi.mock('./useSignedBytes', () => ({ useSignedBytes: () => vi.fn() }))

import { useAutoBuild } from './useAutoBuild'

type Store = ReturnType<typeof makeStore>

/** A scene prepped all the way through refine — its only remaining step is assemble. */
function prepped(id: string, index: number): Scene {
  return {
    id,
    index,
    sourceId: 'source-1',
    title: `Scene ${index + 1}`,
    start: index * 10,
    end: index * 10 + 10,
    transcript: 'hello world',
    status: 'pending',
    clipUrl: `${id}-clip.mp4`,
    clipAudioUrl: `${id}-clip.wav`,
    sheets: [{} as ContactSheet],
    refined: { cuts: [{ start: 1, end: 2 }], source: 'ai' },
  }
}

function makeStore(scenes: Scene[]) {
  const store = configureStore({
    reducer: { studio: studioReducer, [studioApi.reducerPath]: studioApi.reducer },
    middleware: (g) => g().concat(studioApi.middleware),
  })
  store.dispatch(createProject({ id: 'p1', now: 1 }))
  store.dispatch(setScenes(scenes))
  return store
}

// The test store isn't wrapped in redux-persist, so its state lacks the
// `_persist` key `RootState` carries — cast at this one seam rather than drag a
// persistor into a unit test.
const stateOf = (store: Store) =>
  store.getState() as unknown as Parameters<typeof selectActive>[0]
const runOf = (store: Store) => selectActive(stateOf(store)).autoBuild
const scenesOf = (store: Store) => selectActive(stateOf(store)).scenes

/**
 * Stands in for `useScenePipeline`. Only the UPLOAD is a spy (that's the flaky
 * half the tests drive); the durable writes around it are the real ones —
 * `saveSceneCut` patches `assembledUrl` + `status: 'built'` in one go, exactly
 * as `useScenePipeline.saveSceneCut` does, and `markBuilt` patches the status.
 */
function Harness({
  upload,
  sceneError = null,
}: {
  upload: (id: string, blob: Blob) => Promise<string>
  sceneError?: string | null
}) {
  const dispatch = useDispatch()
  const scenes = useSelector((s: { studio: unknown }) =>
    selectActive(s as Parameters<typeof selectActive>[0]).scenes,
  )
  const finalCutUrl = useSelector((s: { studio: unknown }) =>
    selectActive(s as Parameters<typeof selectActive>[0]).finalCutUrl,
  )
  const { run, start, resume } = useAutoBuild({
    scenes,
    sceneError,
    finalCutUrl,
    sliceScene: async () => {},
    generateSceneSheets: async () => {},
    refineScene: async () => {},
    saveSceneCut: async (id: string, blob: Blob) => {
      const url = await upload(id, blob)
      dispatch(patchScene({ id, patch: { assembledUrl: url, status: 'built' } }))
      return url
    },
    saveFinalCut: async (blob: Blob) => {
      dispatch(setFinalCutUrl('final.mp4'))
      return `final.mp4:${blob.size}`
    },
    markBuilt: (id: string) => dispatch(patchScene({ id, patch: { status: 'built' } })),
  })
  return (
    <div>
      <span data-testid="status">{run.status}</span>
      <span data-testid="error">{run.error ?? ''}</span>
      <button onClick={start}>start</button>
      <button onClick={resume}>resume</button>
    </div>
  )
}

/** Click a harness button and let the runner's promise chain settle. */
async function click(name: 'start' | 'resume') {
  await act(async () => {
    screen.getByText(name).click()
  })
}

/** Dispatch into the store from outside React (a manual UI action). */
async function dispatchAct(store: Store, action: Parameters<Store['dispatch']>[0]) {
  await act(async () => {
    store.dispatch(action)
  })
}

const status = () => screen.getByTestId('status').textContent
const error = () => screen.getByTestId('error').textContent

beforeEach(() => {
  vi.clearAllMocks()
  assembleSceneBlobMock.mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
  assembleFinalCutBlobMock.mockResolvedValue(new Blob(['final'], { type: 'video/mp4' }))
})

describe('useAutoBuild — a save that fails on the assemble step', () => {
  it('halts, then clears the halt when the scene is assembled + saved by hand', async () => {
    const store = makeStore([prepped('s1', 0), prepped('s2', 1)])
    const upload = vi.fn().mockRejectedValue(new Error('Failed to fetch'))
    render(
      <Provider store={store}>
        <Harness upload={upload} />
      </Provider>,
    )

    await click('start')
    await waitFor(() => expect(status()).toBe('halted'))
    expect(error()).toContain('Failed to fetch')
    expect(runOf(store).currentSceneId).toBe('s1')
    expect(runOf(store).currentStepId).toBe('assemble')

    // The producer fixes scene 1 by hand: SceneAssembleBar → Save this scene,
    // which is exactly this durable write.
    await dispatchAct(
      store,
      patchScene({ id: 's1', patch: { assembledUrl: 'saved.mp4', status: 'built' } }),
    )

    // The halt pointed at work that is now done — the run is merely paused, and
    // the stale network error is gone from the board.
    await waitFor(() => expect(status()).toBe('paused'))
    expect(error()).toBe('')
  })

  it('does not re-render or re-upload the hand-fixed scene on Resume', async () => {
    const store = makeStore([prepped('s1', 0), prepped('s2', 1)])
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue('s2.mp4')
    render(
      <Provider store={store}>
        <Harness upload={upload} />
      </Provider>,
    )

    await click('start')
    await waitFor(() => expect(status()).toBe('halted'))
    await dispatchAct(
      store,
      patchScene({ id: 's1', patch: { assembledUrl: 'saved.mp4', status: 'built' } }),
    )
    await waitFor(() => expect(status()).toBe('paused'))

    assembleSceneBlobMock.mockClear()
    upload.mockClear()
    await click('resume')

    // Scene 1 is done — the run moves on to scene 2 and never touches s1 again.
    await waitFor(() =>
      expect(scenesOf(store)[1].assembledUrl).toBe('s2.mp4'),
    )
    const assembled = assembleSceneBlobMock.mock.calls.map((c) => c[0].scene.id)
    expect(assembled).not.toContain('s1')
    expect(upload.mock.calls.map((c) => c[0])).not.toContain('s1')
  })

  it('retries the upload on Resume WITHOUT re-running the render', async () => {
    const store = makeStore([prepped('s1', 0)])
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue('s1.mp4')
    render(
      <Provider store={store}>
        <Harness upload={upload} />
      </Provider>,
    )

    await click('start')
    await waitFor(() => expect(status()).toBe('halted'))
    expect(assembleSceneBlobMock).toHaveBeenCalledTimes(1)

    await click('resume')

    // The render is the expensive half (ffmpeg.wasm over the whole scene clip).
    // Only the save failed, so only the save is retried.
    await waitFor(() => expect(scenesOf(store)[0].assembledUrl).toBe('s1.mp4'))
    expect(assembleSceneBlobMock).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledTimes(2)
  })

  it('re-renders instead of reusing the cached blob when the cuts were edited', async () => {
    const store = makeStore([prepped('s1', 0)])
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue('s1.mp4')
    render(
      <Provider store={store}>
        <Harness upload={upload} />
      </Provider>,
    )

    await click('start')
    await waitFor(() => expect(status()).toBe('halted'))

    // The producer re-cuts the scene before resuming — the cached render is now
    // of the WRONG spans and must not be uploaded.
    await dispatchAct(
      store,
      patchScene({
        id: 's1',
        patch: { refined: { cuts: [{ start: 4, end: 8 }], source: 'manual' } },
      }),
    )
    await click('resume')

    await waitFor(() => expect(scenesOf(store)[0].assembledUrl).toBe('s1.mp4'))
    expect(assembleSceneBlobMock).toHaveBeenCalledTimes(2)
  })

  it('retries the step on Resume even when a stale sceneError is still set', async () => {
    // A leftover `sceneError` from an earlier swallowed failure must not make the
    // stale-attempt guard re-halt the run before it retries anything.
    const store = makeStore([prepped('s1', 0)])
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue('s1.mp4')
    render(
      <Provider store={store}>
        <Harness upload={upload} sceneError="an older, already-fixed hiccup" />
      </Provider>,
    )

    await click('start')
    await waitFor(() => expect(status()).toBe('halted'))
    expect(error()).toContain('Failed to fetch')

    await click('resume')

    await waitFor(() => expect(scenesOf(store)[0].assembledUrl).toBe('s1.mp4'))
    expect(upload).toHaveBeenCalledTimes(2)
  })
})
