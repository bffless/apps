/**
 * Auto Build orchestrator (story 03s). When a run is `running`, this hook fires the
 * one next step on the one next scene, then waits: each `pipe` action updates Redux
 * (scene fields, or the shared `sceneError`), the effect re-runs, and `nextAction`
 * recomputes where to go — so progress is driven by state, not a tight loop holding
 * stale callbacks. The cut/sheets/refine/voice actions swallow their errors into
 * `pipe.sceneError`; we detect failure by seeing the pointed step still not done
 * with an error present on the next tick. The assemble step (we own it) and the
 * final stitch throw, so they're caught directly.
 *
 * `liveRef` is the in-session guard: it's only set by an explicit Start/Resume in
 * THIS session, so a persisted `running` status rehydrated after a reload does NOT
 * auto-fire — the runner coerces it to `paused` and the user resumes.
 *
 * Pause/Stop only prevent the NEXT step from starting; an in-flight step always runs
 * to completion (steps aren't cancellable mid-flight).
 */

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '../../store/hooks'
import {
  startAutoBuild,
  pauseAutoBuild,
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
  nextAction,
  isHaltStale,
  assembleInputsKey,
  type AutoStepId,
  type AutoBuildRun,
  type ActiveStep,
} from '../../lib/autoBuild'
import { assembleSceneBlob, assembleFinalCutBlob } from '../../lib/export/assembleScene'
import { autoBuildError } from './useScenePipeline'
import { useSignedBytes } from './useSignedBytes'
import type { Scene } from '../../lib/scenes'

/** The slice of `useScenePipeline` the orchestrator drives. */
type Pipe = {
  scenes: Scene[]
  sceneError: string | null
  finalCutUrl: string | null
  sliceScene: (id: string) => Promise<void>
  generateSceneSheets: (id: string) => Promise<void>
  refineScene: (id: string) => Promise<void>
  saveSceneCut: (id: string, blob: Blob) => Promise<string>
  saveFinalCut: (blob: Blob) => Promise<string>
  markBuilt: (id: string) => void
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

  // In-flight guard (one step at a time) and the last step we attempted (to tell a
  // genuine failure apart from a benign warning that left the step done).
  const inFlightRef = useRef(false)
  const attemptRef = useRef<{ sceneId: string; stepId: AutoStepId } | null>(null)
  // Only true after an explicit Start/Resume in this session — gates the runner so
  // a rehydrated `running` never auto-fires.
  const liveRef = useRef(false)
  // The last scene MP4 we rendered but did NOT manage to save. The assemble step is
  // two halves — an ffmpeg.wasm render (minutes) and an upload (seconds) — and only
  // the upload is realistically flaky. Holding the rendered blob across the halt
  // means Resume after a failed save retries just the upload instead of re-paying
  // for the render (issue #220). One slot is enough: the runner only ever has one
  // scene in flight, and a successful save drops it (an MP4 is heavy). `key` is the
  // fingerprint of the render's inputs — if the producer re-cut the scene while the
  // run was halted, it no longer matches and we render again rather than upload a
  // clip of the wrong timeline.
  const renderRef = useRef<{ sceneId: string; key: string; blob: Blob } | null>(null)
  // Advancement nudge. The runner relies on re-running after a step finishes; the
  // incidental re-render from the step's own `patchScene` can flush this effect
  // WHILE `inFlightRef` is still true (React can flush a prior update's passive
  // effects when the action's `finally` fires its `setXxxId(null)`), and then no
  // dep change re-triggers it — the run stalls "running" with the step done. So
  // each step bumps `tick` AFTER clearing `inFlightRef`, guaranteeing exactly one
  // re-run with the guard already false that fires the next step.
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
    attemptRef.current = null
    dispatch(pauseAutoBuild())
  }, [dispatch])
  const stop = useCallback(() => {
    liveRef.current = false
    attemptRef.current = null
    dispatch(stopAutoBuild())
  }, [dispatch])

  // Keep `pipe` in a ref so the runner reads the CURRENT actions/state while staying
  // keyed to just the signals that should re-trigger it (status, scenes, sceneError,
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
      dispatch(pauseAutoBuild())
      return
    }
    if (inFlightRef.current) return
    const p = pipeRef.current
    const action = nextAction(p.scenes)

    // No pending scenes → stitch the final cut once, then finish.
    if (!action) {
      inFlightRef.current = true
      const a: ActiveStep = { sceneId: null, stepId: 'stitch' }
      dispatch(autoStepStarted(a))
      ;(async () => {
        try {
          if (!p.finalCutUrl) {
            const blob = await assembleFinalCutBlob({ scenes: p.scenes, fetchBytes })
            await p.saveFinalCut(blob)
          }
          liveRef.current = false
          dispatch(completeAutoBuild())
        } catch (e) {
          liveRef.current = false
          dispatch(haltAutoBuild({ ...a, message: autoBuildError(e) }))
        } finally {
          dispatch(autoStepFinished(a))
          inFlightRef.current = false
          bump()
        }
      })()
      return
    }

    const { scene, step } = action

    // The step we just attempted is STILL the next step and an error surfaced → halt.
    const attempted = attemptRef.current
    if (attempted && attempted.sceneId === scene.id && attempted.stepId === step && p.sceneError) {
      attemptRef.current = null
      liveRef.current = false
      dispatch(haltAutoBuild({ sceneId: scene.id, stepId: step, message: p.sceneError }))
      return
    }

    // All steps done but not yet built → mark it built and let the effect re-run.
    if (step === null) {
      p.markBuilt(scene.id)
      return
    }

    attemptRef.current = { sceneId: scene.id, stepId: step }
    inFlightRef.current = true
    dispatch(autoStepStarted({ sceneId: scene.id, stepId: step }))
    ;(async () => {
      try {
        await runStep(step, scene, p, fetchBytes, renderRef)
      } catch (e) {
        // Only the assemble step / save throw; swallowing steps are caught via the
        // attemptRef path above on the next tick. Clear the attempt: this halt has
        // already been recorded from the thrown error, so leaving it set would make
        // the next Resume hit the stale-attempt branch above and re-halt on whatever
        // `sceneError` happens to be lying around instead of retrying (issue #220).
        attemptRef.current = null
        liveRef.current = false
        dispatch(haltAutoBuild({ sceneId: scene.id, stepId: step, message: autoBuildError(e) }))
      } finally {
        dispatch(autoStepFinished({ sceneId: scene.id, stepId: step }))
        inFlightRef.current = false
        bump()
      }
    })()
    // The runner reads pipe via `pipeRef`; it's keyed only to the signals that must
    // re-trigger it (plus `tick`, the post-step advancement nudge).
  }, [run.status, pipe.scenes, pipe.sceneError, pipe.finalCutUrl, tick, dispatch, fetchBytes])

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

  // assemble: render the scene MP4 then save it (both throw on failure). Reuse the
  // render we already paid for if this is a retry of a save that failed and nothing
  // about the scene's cut has changed since.
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
