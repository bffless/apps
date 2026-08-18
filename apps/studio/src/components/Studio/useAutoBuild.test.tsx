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

// Which backend the assemble/stitch call sites see — defaults to 'wasm' so the
// pre-existing (task 6-and-earlier) expectations hold unchanged; individual
// tests below flip it to 'server'/'remote'.
const { getVideoBackendMock, getResolvedVideoBackendMock } = vi.hoisted(() => ({
  getVideoBackendMock: vi.fn(),
  getResolvedVideoBackendMock: vi.fn(),
}))
vi.mock('../../lib/videoBackend', () => ({
  getVideoBackend: getVideoBackendMock,
  getResolvedVideoBackend: getResolvedVideoBackendMock,
}))

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

/** Stable defaults — a fresh literal per render would re-key the runner effect. */
const NO_SCENE_ERRORS: Record<string, string> = {}
const noop = async () => {}

/**
 * Stands in for `useScenePipeline`. Only the UPLOAD is a spy (that's the flaky
 * half the tests drive); the durable writes around it are the real ones —
 * `saveSceneCut` patches `assembledUrl` + `status: 'built'` in one go, exactly
 * as `useScenePipeline.saveSceneCut` does, and `markBuilt` patches the status.
 */
function Harness({
  upload,
  sceneErrors = NO_SCENE_ERRORS,
  sliceScene = noop,
  generateSceneSheets = noop,
  refineScene = noop,
  assembleSceneRemote,
  stitchFinalCutRemote,
}: {
  upload: (id: string, blob: Blob) => Promise<string>
  sceneErrors?: Record<string, string>
  sliceScene?: (id: string) => Promise<void>
  generateSceneSheets?: (id: string) => Promise<void>
  refineScene?: (id: string) => Promise<void>
  assembleSceneRemote?: (id: string) => Promise<void>
  stitchFinalCutRemote?: () => Promise<void>
}) {
  const dispatch = useDispatch()
  const scenes = useSelector((s: { studio: unknown }) =>
    selectActive(s as Parameters<typeof selectActive>[0]).scenes,
  )
  const finalCutUrl = useSelector((s: { studio: unknown }) =>
    selectActive(s as Parameters<typeof selectActive>[0]).finalCutUrl,
  )
  const { run, start, resume, pause, stop } = useAutoBuild({
    scenes,
    sceneErrors,
    finalCutUrl,
    sliceScene,
    generateSceneSheets,
    refineScene,
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
    // Only exercised when a test forces the backend to 'server' — the wasm-path
    // tests never call these, but the hook's Pipe type requires them.
    assembleSceneRemote:
      assembleSceneRemote ??
      (async (id: string) => {
        dispatch(patchScene({ id, patch: { assembledUrl: 'unused.mp4', status: 'built' } }))
      }),
    stitchFinalCutRemote:
      stitchFinalCutRemote ??
      (async () => {
        dispatch(setFinalCutUrl('unused-final.mp4'))
      }),
  })
  return (
    <div>
      <span data-testid="status">{run.status}</span>
      <span data-testid="error">{run.halt?.message ?? ''}</span>
      <button onClick={start}>start</button>
      <button onClick={resume}>resume</button>
      <button onClick={pause}>pause</button>
      <button onClick={stop}>stop</button>
    </div>
  )
}

/** Click a harness button and let the runner's promise chain settle. */
async function click(name: 'start' | 'resume' | 'pause' | 'stop') {
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

/** Point both mocks at one backend (the hook reads the resolved shape at Start). */
function backend(
  b: 'wasm' | 'server' | 'remote',
  executor: 'local' | 'remote' | null = b === 'remote' ? 'remote' : b === 'server' ? 'local' : null,
) {
  getVideoBackendMock.mockResolvedValue(b)
  getResolvedVideoBackendMock.mockResolvedValue({ backend: b, executor, source: 'stored', note: null, probe: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  assembleSceneBlobMock.mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
  assembleFinalCutBlobMock.mockResolvedValue(new Blob(['final'], { type: 'video/mp4' }))
  getVideoBackendMock.mockResolvedValue('wasm')
  backend('wasm')
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
    expect(runOf(store).halt).toEqual({
      sceneId: 's1',
      stepId: 'assemble',
      message: expect.stringContaining('Failed to fetch'),
    })

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
    // A leftover error for this scene from an earlier swallowed failure must not
    // make the stale-attempt guard re-halt the run before it retries anything.
    const store = makeStore([prepped('s1', 0)])
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValue('s1.mp4')
    render(
      <Provider store={store}>
        <Harness upload={upload} sceneErrors={{ s1: 'an older, already-fixed hiccup' }} />
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

/** A promise the test resolves by hand, to hold a step in flight. */
function deferred<T = void>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** A scene cut + sheeted but not yet refined — its next step is refine. */
function atRefine(id: string, index: number): Scene {
  return { ...prepped(id, index), refined: undefined }
}

describe('useAutoBuild — parallel launch', () => {
  it('runs scene 2 refine while scene 1 assembles', async () => {
    const store = makeStore([prepped('s1', 0), atRefine('s2', 1)])
    const renderGate = deferred<Blob>()
    assembleSceneBlobMock.mockReturnValue(renderGate.promise) // s1 assemble hangs
    const refineGate = deferred()
    const refineScene = vi.fn().mockReturnValue(refineGate.promise) // s2 refine hangs
    const upload = vi.fn().mockResolvedValue('s1.mp4')
    render(
      <Provider store={store}>
        <Harness upload={upload} refineScene={refineScene} />
      </Provider>,
    )

    await click('start')
    // BOTH steps are in flight at once — the sequential runner could never
    // show two entries here.
    await waitFor(() =>
      expect(runOf(store).active).toEqual(
        expect.arrayContaining([
          { sceneId: 's1', stepId: 'assemble' },
          { sceneId: 's2', stepId: 'refine' },
        ]),
      ),
    )
    expect(refineScene).toHaveBeenCalledWith('s2')

    // Finish s2's refine (write the durable field, as the real pipe would),
    // then release s1's render; the run drives both scenes home.
    await act(async () => {
      store.dispatch(patchScene({ id: 's2', patch: { refined: { cuts: [], source: 'ai' } } }))
      refineGate.resolve()
    })
    await act(async () => {
      renderGate.resolve(new Blob(['mp4'], { type: 'video/mp4' }))
    })
    await waitFor(() => expect(scenesOf(store)[0].assembledUrl).toBe('s1.mp4'))
  })

  it('never runs two ffmpeg-lane steps at once', async () => {
    // s1 is at assemble (ffmpeg), s2 is bare — its cut also needs ffmpeg.
    const store = makeStore([
      prepped('s1', 0),
      {
        ...prepped('s2', 1),
        clipUrl: undefined,
        clipAudioUrl: undefined,
        sheets: undefined,
        refined: undefined,
      },
    ])
    const renderGate = deferred<Blob>()
    assembleSceneBlobMock.mockReturnValue(renderGate.promise)
    const sliceScene = vi.fn().mockResolvedValue(undefined)
    render(
      <Provider store={store}>
        <Harness upload={vi.fn().mockResolvedValue('s1.mp4')} sliceScene={sliceScene} />
      </Provider>,
    )

    await click('start')
    await waitFor(() =>
      expect(runOf(store).active).toEqual([{ sceneId: 's1', stepId: 'assemble' }]),
    )
    expect(sliceScene).not.toHaveBeenCalled() // ffmpeg lane is busy with s1
  })

  it('remote backend: cuts several scenes at once (cap = min(8, scenes))', async () => {
    backend('remote')
    const bare = (id: string, i: number): Scene => ({ ...prepped(id, i), clipUrl: undefined, clipAudioUrl: undefined, sheets: undefined, refined: undefined })
    const store = makeStore([bare('a', 0), bare('b', 1), bare('c', 2)])
    let inFlight = 0
    let peak = 0
    const gate: Array<() => void> = []
    const sliceScene = (id: string) =>
      new Promise<void>((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        gate.push(() => {
          inFlight -= 1
          store.dispatch(patchScene({ id, patch: { clipUrl: `${id}.mp4`, clipAudioUrl: `${id}.wav` } }))
          resolve()
        })
      })
    // The test only cares about cut-step concurrency; give sheets/refine real
    // (if minimal) durable writes so the runner doesn't retry a no-op step forever
    // once the cuts land.
    const generateSceneSheets = (id: string) => {
      store.dispatch(patchScene({ id, patch: { sheets: [{} as ContactSheet] } }))
      return Promise.resolve()
    }
    const refineScene = (id: string) => {
      store.dispatch(patchScene({ id, patch: { refined: { cuts: [], source: 'ai' } } }))
      return Promise.resolve()
    }
    render(
      <Provider store={store}>
        <Harness
          upload={vi.fn()}
          sliceScene={sliceScene}
          generateSceneSheets={generateSceneSheets}
          refineScene={refineScene}
        />
      </Provider>,
    )
    await click('start')
    await waitFor(() => expect(peak).toBe(3))
    await act(async () => { gate.splice(0).forEach((g) => g()) })
    await waitFor(() => expect(scenesOf(store).every((s) => !!s.clipUrl)).toBe(true))
  })

  it('local (server) backend keeps the ffmpeg lane at 1', async () => {
    backend('server', 'local')
    const bare = (id: string, i: number): Scene => ({ ...prepped(id, i), clipUrl: undefined, clipAudioUrl: undefined, sheets: undefined, refined: undefined })
    const store = makeStore([bare('a', 0), bare('b', 1), bare('c', 2)])
    let peak = 0
    let inFlight = 0
    const sliceScene = (id: string) =>
      new Promise<void>((resolve) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        setTimeout(() => {
          inFlight -= 1
          store.dispatch(patchScene({ id, patch: { clipUrl: `${id}.mp4`, clipAudioUrl: `${id}.wav` } }))
          resolve()
        }, 5)
      })
    // Same as the remote test above: real (if minimal) sheets/refine writes so the
    // runner doesn't retry a no-op step forever once the cuts land.
    const generateSceneSheets = (id: string) => {
      store.dispatch(patchScene({ id, patch: { sheets: [{} as ContactSheet] } }))
      return Promise.resolve()
    }
    const refineScene = (id: string) => {
      store.dispatch(patchScene({ id, patch: { refined: { cuts: [], source: 'ai' } } }))
      return Promise.resolve()
    }
    render(
      <Provider store={store}>
        <Harness
          upload={vi.fn()}
          sliceScene={sliceScene}
          generateSceneSheets={generateSceneSheets}
          refineScene={refineScene}
        />
      </Provider>,
    )
    await click('start')
    await waitFor(() => expect(scenesOf(store).every((s) => !!s.clipUrl)).toBe(true))
    expect(peak).toBe(1)
  })

  it('a Pause that lands while Resume is still awaiting the backend probe wins — the run does not resurrect', async () => {
    // Reach a paused run first, with the probe resolving normally. The cut step
    // hangs (never resolves) so `start` leaves the run genuinely `running` —
    // otherwise this one-scene fixture would finish and Pause would be a no-op.
    const store = makeStore([{ ...prepped('s1', 0), clipUrl: undefined, clipAudioUrl: undefined }])
    const sliceScene = () => new Promise<void>(() => {}) // never resolves
    render(
      <Provider store={store}>
        <Harness upload={vi.fn()} sliceScene={sliceScene} />
      </Provider>,
    )
    await click('start')
    await waitFor(() => expect(status()).toBe('running'))
    await click('pause')
    await waitFor(() => expect(status()).toBe('paused'))
    const activeBeforeRace = runOf(store).active

    // Now make Resume's probe hang, so a second Pause can land while it's still
    // in flight. Racing with Pause (not Stop) here is the discriminating case:
    // `stopAutoBuild` unconditionally resets to `idle`, and `resumeAutoBuild`'s
    // OWN guard (`status === 'paused' || 'halted'`) already no-ops against `idle`
    // — so a Resume/Stop race can't actually resurrect anything, guard or no
    // guard. But `pauseAutoBuild` only transitions FROM `running`; clicking Pause
    // while already `paused` is a no-op on Redux status, so without the
    // generation guard the stale Resume's `dispatch(resumeAutoBuild())` still
    // sees `status === 'paused'` when it finally lands and flips it to
    // `running` — resurrecting the paused run. This is exactly what
    // `startGenRef` exists to prevent (bumped by Pause even when its own
    // dispatch is a status no-op).
    const probeGate = deferred<{
      backend: 'wasm'
      executor: null
      source: 'stored'
      note: null
      probe: null
    }>()
    getResolvedVideoBackendMock.mockReturnValueOnce(probeGate.promise)

    await click('resume') // fires off decideCaps(); doesn't wait for it to settle
    await click('pause') // lands first — status stays 'paused' (pause is a no-op here)
    expect(status()).toBe('paused')

    // The stale Resume's probe finally resolves — it must see its generation is
    // no longer current and bail out instead of resurrecting the paused run.
    await act(async () => {
      probeGate.resolve({ backend: 'wasm', executor: null, source: 'stored', note: null, probe: null })
    })

    expect(status()).toBe('paused')
    expect(runOf(store).active).toEqual(activeBeforeRace) // no NEW step launched
  })

  it('halts on the failing scene without blaming a concurrent healthy one', async () => {
    // s2's refine fails the way the real pipe fails: the action resolves
    // (swallowed error), writes NO durable `refined`, and the scene's entry in
    // `sceneErrors` carries the message. Passing the error from the start is
    // deterministic: the attempt scan runs BEFORE any relaunch on the pass
    // after the refine settles, so the run halts instead of looping.
    const store = makeStore([prepped('s1', 0), atRefine('s2', 1)])
    assembleSceneBlobMock.mockResolvedValue(new Blob(['mp4'], { type: 'video/mp4' }))
    const refineScene = vi.fn().mockResolvedValue(undefined)
    const upload = vi.fn().mockResolvedValue('s1.mp4')
    render(
      <Provider store={store}>
        <Harness
          upload={upload}
          refineScene={refineScene}
          sceneErrors={{ s2: 'REPLICATE_NOT_CONFIGURED' }}
        />
      </Provider>,
    )

    await click('start')
    await waitFor(() => expect(status()).toBe('halted'))
    expect(runOf(store).halt).toEqual({
      sceneId: 's2',
      stepId: 'refine',
      message: 'REPLICATE_NOT_CONFIGURED',
    })
    expect(refineScene).toHaveBeenCalledTimes(1) // halted, not relaunched
  })
})

describe('useAutoBuild — server video backend', () => {
  it('assemble step calls assembleSceneRemote, never the wasm render', async () => {
    backend('server')
    const store = makeStore([prepped('s1', 0)])
    const assembleSceneRemote = vi.fn().mockImplementation(async (id: string) => {
      store.dispatch(patchScene({ id, patch: { assembledUrl: 'server-s1.mp4', status: 'built' } }))
    })
    render(
      <Provider store={store}>
        <Harness upload={vi.fn()} assembleSceneRemote={assembleSceneRemote} />
      </Provider>,
    )

    await click('start')

    await waitFor(() => expect(scenesOf(store)[0].assembledUrl).toBe('server-s1.mp4'))
    expect(assembleSceneRemote).toHaveBeenCalledWith('s1')
    expect(assembleSceneBlobMock).not.toHaveBeenCalled()
  })

  it('a thrown assemble-step error halts the run (same regime as the wasm path)', async () => {
    backend('server')
    const store = makeStore([prepped('s1', 0)])
    const assembleSceneRemote = vi.fn().mockRejectedValue(new Error('server render failed'))
    render(
      <Provider store={store}>
        <Harness upload={vi.fn()} assembleSceneRemote={assembleSceneRemote} />
      </Provider>,
    )

    await click('start')

    await waitFor(() => expect(status()).toBe('halted'))
    expect(runOf(store).halt).toEqual({
      sceneId: 's1',
      stepId: 'assemble',
      message: expect.stringContaining('server render failed'),
    })
  })

  it('stitch action calls stitchFinalCutRemote, never the wasm concat', async () => {
    backend('server')
    // A single already-built, already-assembled scene: assemble is done, so the
    // only remaining action is the final stitch.
    const store = makeStore([{ ...prepped('s1', 0), status: 'built', assembledUrl: 's1.mp4' }])
    const stitchFinalCutRemote = vi.fn().mockImplementation(async () => {
      store.dispatch(setFinalCutUrl('server-final.mp4'))
    })
    render(
      <Provider store={store}>
        <Harness upload={vi.fn()} stitchFinalCutRemote={stitchFinalCutRemote} />
      </Provider>,
    )

    await click('start')

    await waitFor(() => expect(status()).toBe('done'))
    expect(stitchFinalCutRemote).toHaveBeenCalledTimes(1)
    expect(assembleFinalCutBlobMock).not.toHaveBeenCalled()
  })

  it('a thrown stitch error halts the run (same regime as the wasm path)', async () => {
    backend('server')
    const store = makeStore([{ ...prepped('s1', 0), status: 'built', assembledUrl: 's1.mp4' }])
    const stitchFinalCutRemote = vi.fn().mockRejectedValue(new Error('concat job timed out'))
    render(
      <Provider store={store}>
        <Harness upload={vi.fn()} stitchFinalCutRemote={stitchFinalCutRemote} />
      </Provider>,
    )

    await click('start')

    await waitFor(() => expect(status()).toBe('halted'))
    expect(runOf(store).halt).toEqual({
      sceneId: null,
      stepId: 'stitch',
      message: expect.stringContaining('concat job timed out'),
    })
  })
})
