/**
 * Auto Build orchestrator (stories 03s, 03u). When a run is `running`, this hook
 * launches EVERY step the run may start right now and then waits: each `pipe`
 * action updates Redux (scene fields, or that scene's entry in `sceneErrors`), the
 * effect re-runs, and `nextActions` recomputes the whole frontier — so progress is
 * driven by state, not a tight loop holding stale callbacks.
 *
 * Concurrency is a **lane scheduler**, not a step pointer: `nextActions` admits one
 * step per scene, capped by the shared resource each step occupies (`STEP_LANE` —
 * cut/assemble share the single ffmpeg.wasm instance; refine is a server poll;
 * sheets is main-thread canvas capture). So scene 2 can refine while scene 1
 * assembles, but two ffmpeg steps never overlap. `inFlightRef` is the runner's own
 * source of truth for what's executing (Redux `active` mirrors it for the board,
 * but a rehydrated `active` is stale by definition, so we never read it back).
 *
 * The cut/sheets/refine actions swallow their errors into `pipe.sceneErrors[id]`;
 * we detect failure per scene by seeing a step we attempted still be that scene's
 * next step with that scene's error present on a later pass — per-scene errors mean
 * one scene's stale error can never halt another scene's concurrent attempt. The
 * assemble step (we own it) and the final stitch throw, so they're caught directly.
 *
 * `liveRef` is the in-session guard: it's only set by an explicit Start/Resume in
 * THIS session, so a persisted `running` status rehydrated after a reload does NOT
 * auto-fire — the runner coerces it to `paused` and the user resumes. It's cleared
 * again the moment the run halts or completes.
 *
 * Pause/Stop only prevent the NEXT steps from starting; every in-flight step always
 * runs to completion (steps aren't cancellable mid-flight).
 */

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '../../store/hooks'
import {
  startAutoBuild,
  pauseAutoBuild,
  coerceAutoBuildPaused,
  resumeAutoBuild,
  stopAutoBuild,
  haltAutoBuild,
  clearAutoHalt,
  completeAutoBuild,
  autoStepStarted,
  autoStepFinished,
  selectActive,
} from '../../store/studioSlice'
import {
  nextActions,
  nextStep,
  isHaltStale,
  assembleInputsKey,
  type AutoStepId,
  type AutoBuildRun,
  type ActiveStep,
} from '../../lib/autoBuild'
import { assembleSceneBlob, assembleFinalCutBlob } from '../../lib/export/assembleScene'
import { autoBuildError } from './useScenePipeline'
import { useSignedBytes } from './useSignedBytes'
import { getVideoBackend } from '../../lib/videoBackend'
import type { Scene } from '../../lib/scenes'

/** The slice of `useScenePipeline` the orchestrator drives. */
type Pipe = {
  scenes: Scene[]
  sceneErrors: Record<string, string>
  finalCutUrl: string | null
  sliceScene: (id: string) => Promise<void>
  generateSceneSheets: (id: string) => Promise<void>
  refineScene: (id: string) => Promise<void>
  saveSceneCut: (id: string, blob: Blob) => Promise<string>
  saveFinalCut: (blob: Blob) => Promise<string>
  markBuilt: (id: string) => void
  // Server-side equivalents (story video-ops task 7) — each does the render AND
  // the persist in one job, so the assemble/stitch step is a single call rather
  // than render-then-save. Both throw on failure, same regime as the wasm path.
  assembleSceneRemote: (id: string) => Promise<void>
  stitchFinalCutRemote: () => Promise<void>
}

export type AutoBuildControls = {
  run: AutoBuildRun
  start: () => void
  pause: () => void
  resume: () => void
  stop: () => void
}

export function useAutoBuild(pipe: Pipe): AutoBuildControls {
  const dispatch = useAppDispatch()
  const run = useAppSelector((s) => selectActive(s).autoBuild)
  const fetchBytes = useSignedBytes()

  // Steps currently executing, keyed `${sceneId}:${stepId}` — the runner's source of
  // truth for what's in flight (the Redux `active` set mirrors it for the board, but
  // a rehydrated run must start empty, so we never read it back).
  const inFlightRef = useRef(new Map<string, ActiveStep>())
  // The last step ATTEMPTED per scene, to tell a genuine failure (step still next +
  // that scene's error set) from a benign warning that left it done.
  const attemptRef = useRef(new Map<string, AutoStepId>())
  const keyOf = (a: ActiveStep) => `${a.sceneId ?? ''}:${a.stepId}`
  // Only true after an explicit Start/Resume in this session — gates the runner so
  // a rehydrated `running` never auto-fires.
  const liveRef = useRef(false)
  // The last scene MP4 we rendered but did NOT manage to save. The assemble step is
  // two halves — an ffmpeg.wasm render (minutes) and an upload (seconds) — and only
  // the upload is realistically flaky. Holding the rendered blob across the halt
  // means Resume after a failed save retries just the upload instead of re-paying
  // for the render (issue #220). One slot is enough even under the parallel runner:
  // assemble sits in the ffmpeg lane (capacity 1), so at most one scene is ever
  // rendering, and a successful save drops it (an MP4 is heavy). `key` is the
  // fingerprint of the render's inputs — if the producer re-cut the scene while the
  // run was halted, it no longer matches and we render again rather than upload a
  // clip of the wrong timeline.
  const renderRef = useRef<{ sceneId: string; key: string; blob: Blob } | null>(null)
  // Advancement nudge. The runner relies on re-running after a step finishes; the
  // incidental re-render from the step's own `patchScene` can flush this effect
  // WHILE the step is still in `inFlightRef` (React can flush a prior update's
  // passive effects when the action's `finally` fires its `setXxxId(null)`), and
  // then no dep change re-triggers it — the run stalls "running" with the step
  // done. So each step bumps `tick` AFTER removing itself from `inFlightRef`,
  // guaranteeing exactly one re-run with the lane already free.
  const [tick, bump] = useReducer((n: number) => n + 1, 0)

  const start = useCallback(() => {
    liveRef.current = true
    dispatch(startAutoBuild())
  }, [dispatch])
  const resume = useCallback(() => {
    liveRef.current = true
    dispatch(resumeAutoBuild())
  }, [dispatch])
  const pause = useCallback(() => {
    liveRef.current = false
    attemptRef.current.clear()
    dispatch(pauseAutoBuild())
  }, [dispatch])
  const stop = useCallback(() => {
    liveRef.current = false
    attemptRef.current.clear()
    dispatch(stopAutoBuild())
  }, [dispatch])

  // Keep `pipe` in a ref so the runner reads the CURRENT actions/state while staying
  // keyed to just the signals that should re-trigger it (status, scenes, sceneErrors,
  // finalCutUrl) — `pipe` itself is a fresh object every render.
  // useLayoutEffect (not useEffect): react-hooks/refs forbids writing a ref during render;
  // a layout effect runs before the runner's passive effect so pipeRef is current when it reads.
  const pipeRef = useRef(pipe)
  useLayoutEffect(() => {
    pipeRef.current = pipe
  })

  // A halt names one failed step. The producer can fix that step by hand — assemble
  // + save the scene from the editor below the board — and when they do, the halt is
  // describing work that's now done: drop it, so the board stops reading `✗ Halted`
  // with a stale network error over a scene that says `✓ built` (issue #220). The
  // run stays stopped (`paused`) — clearing a halt is not consent to carry on.
  useEffect(() => {
    if (isHaltStale(pipe.scenes, run, pipe.finalCutUrl)) dispatch(clearAutoHalt())
  }, [pipe.scenes, pipe.finalCutUrl, run, dispatch])

  useEffect(() => {
    if (run.status !== 'running') return
    // A persisted `running` rehydrated after a reload (redux-persist hydrates
    // asynchronously, so status can flip to `running` AFTER mount) is not actually
    // in flight — coerce it to `paused` and wait for an explicit Resume. `liveRef`
    // is only set by Start/Resume in THIS session, so this never fires mid-run.
    if (!liveRef.current) {
      dispatch(coerceAutoBuildPaused())
      return
    }
    const p = pipeRef.current

    // Failure detection for the swallowing steps (cut/sheets/refine): an attempt
    // that's no longer in flight, whose step is STILL the scene's next step, with
    // THAT scene's error present → halt. Per-scene errors mean a stale error from
    // one scene can never halt another's attempt.
    for (const [sceneId, stepId] of attemptRef.current) {
      if (inFlightRef.current.has(keyOf({ sceneId, stepId }))) continue
      const scene = p.scenes.find((s) => s.id === sceneId)
      if (!scene || nextStep(scene) !== stepId) {
        attemptRef.current.delete(sceneId) // step advanced (or scene gone) — benign
        continue
      }
      const message = p.sceneErrors[sceneId]
      if (message) {
        attemptRef.current.delete(sceneId)
        liveRef.current = false
        dispatch(haltAutoBuild({ sceneId, stepId, message }))
        return
      }
    }

    const actions = nextActions(p.scenes, [...inFlightRef.current.values()])

    // Mark-built is instant bookkeeping — do ONE per pass (it reads the scenes
    // snapshot for the selection advance) and let the state change re-run us.
    const done = actions.find((a) => a.kind === 'markBuilt')
    if (done) {
      p.markBuilt(done.scene.id)
      return
    }

    for (const action of actions) {
      if (action.kind === 'stitch') {
        const a: ActiveStep = { sceneId: null, stepId: 'stitch' }
        inFlightRef.current.set(keyOf(a), a)
        dispatch(autoStepStarted(a))
        ;(async () => {
          try {
            if (!p.finalCutUrl) {
              if ((await getVideoBackend()) !== 'wasm') {
                await p.stitchFinalCutRemote()
              } else {
                const blob = await assembleFinalCutBlob({ scenes: p.scenes, fetchBytes })
                await p.saveFinalCut(blob)
              }
            }
            liveRef.current = false
            dispatch(completeAutoBuild())
          } catch (e) {
            liveRef.current = false
            dispatch(haltAutoBuild({ ...a, message: autoBuildError(e) }))
          } finally {
            dispatch(autoStepFinished(a))
            inFlightRef.current.delete(keyOf(a))
            bump()
          }
        })()
        continue
      }
      if (action.kind !== 'step') continue
      const { scene, step } = action
      const a: ActiveStep = { sceneId: scene.id, stepId: step }
      if (inFlightRef.current.has(keyOf(a))) continue
      inFlightRef.current.set(keyOf(a), a)
      attemptRef.current.set(scene.id, step)
      dispatch(autoStepStarted(a))
      ;(async () => {
        try {
          await runStep(step, scene, p, fetchBytes, renderRef)
        } catch (e) {
          // Only assemble / save throw; the swallowing steps are caught by the
          // attempt scan above on a later pass. Clear the attempt so Resume
          // retries instead of re-halting on a leftover error (issue #220).
          attemptRef.current.delete(scene.id)
          liveRef.current = false
          dispatch(haltAutoBuild({ sceneId: scene.id, stepId: step, message: autoBuildError(e) }))
        } finally {
          dispatch(autoStepFinished(a))
          inFlightRef.current.delete(keyOf(a))
          bump()
        }
      })()
    }
    // The runner reads pipe via `pipeRef`; it's keyed only to the signals that must
    // re-trigger it (plus `tick`, the post-step advancement nudge).
  }, [run.status, pipe.scenes, pipe.sceneErrors, pipe.finalCutUrl, tick, dispatch, fetchBytes])

  return { run, start, pause, resume, stop }
}

/** Fire one step. cut/sheets/refine swallow errors into `sceneError`;
 *  assemble (render + save) throws, so the caller's catch halts the run. */
async function runStep(
  step: AutoStepId,
  scene: Scene,
  p: Pipe,
  fetchBytes: (url: string) => Promise<Uint8Array>,
  renderRef: RenderRef,
): Promise<void> {
  if (step === 'cut') return p.sliceScene(scene.id)
  if (step === 'sheets') return p.generateSceneSheets(scene.id)
  if (step === 'refine') return p.refineScene(scene.id)

  // assemble, server backend (any non-wasm choice): one job does the render
  // AND the persist — no separate blob to hold across a halt, so `renderRef`
  // never enters play.
  if ((await getVideoBackend()) !== 'wasm') return p.assembleSceneRemote(scene.id)

  // assemble, wasm backend: render the scene MP4 then save it (both throw on
  // failure). Reuse the render we already paid for if this is a retry of a save
  // that failed and nothing about the scene's cut has changed since.
  const key = assembleInputsKey(scene)
  const held = renderRef.current
  const blob =
    held && held.sceneId === scene.id && held.key === key
      ? held.blob
      : await assembleSceneBlob({ scene, fetchBytes })
  renderRef.current = { sceneId: scene.id, key, blob }

  await p.saveSceneCut(scene.id, blob)
  // Saved — the bytes are durable now, so let the blob go.
  renderRef.current = null
}

type RenderRef = { current: { sceneId: string; key: string; blob: Blob } | null }
