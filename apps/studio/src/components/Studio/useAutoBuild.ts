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
  completeAutoBuild,
  setAutoPointer,
  selectActive,
} from '../../store/studioSlice'
import { nextAction, type AutoStepId, type AutoBuildRun } from '../../lib/autoBuild'
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
  voiceAllSegments: (id: string) => Promise<void>
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
      ;(async () => {
        try {
          if (!p.finalCutUrl) {
            dispatch(setAutoPointer({ sceneId: null, stepId: 'stitch' }))
            const blob = await assembleFinalCutBlob({ scenes: p.scenes, fetchBytes })
            await p.saveFinalCut(blob)
          }
          liveRef.current = false
          dispatch(completeAutoBuild())
        } catch (e) {
          liveRef.current = false
          dispatch(haltAutoBuild(autoBuildError(e)))
        } finally {
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
      dispatch(haltAutoBuild(p.sceneError))
      return
    }

    // All steps done but not yet built → mark it built and let the effect re-run.
    if (step === null) {
      p.markBuilt(scene.id)
      return
    }

    attemptRef.current = { sceneId: scene.id, stepId: step }
    inFlightRef.current = true
    dispatch(setAutoPointer({ sceneId: scene.id, stepId: step }))
    ;(async () => {
      try {
        await runStep(step, scene, p, fetchBytes)
      } catch (e) {
        // Only the assemble step / save throw; swallowing steps are caught via the
        // attemptRef path above on the next tick.
        liveRef.current = false
        dispatch(haltAutoBuild(autoBuildError(e)))
      } finally {
        inFlightRef.current = false
        bump()
      }
    })()
    // The runner reads pipe via `pipeRef`; it's keyed only to the signals that must
    // re-trigger it (plus `tick`, the post-step advancement nudge).
  }, [run.status, pipe.scenes, pipe.sceneError, pipe.finalCutUrl, tick, dispatch, fetchBytes])

  return { run, start, pause, resume, stop }
}

/** Fire one step. cut/sheets/refine/voice swallow errors into `sceneError`;
 *  assemble (render + save) throws, so the caller's catch halts the run. */
async function runStep(
  step: AutoStepId,
  scene: Scene,
  p: Pipe,
  fetchBytes: (url: string) => Promise<Uint8Array>,
): Promise<void> {
  if (step === 'cut') return p.sliceScene(scene.id)
  if (step === 'sheets') return p.generateSceneSheets(scene.id)
  if (step === 'refine') return p.refineScene(scene.id)
  if (step === 'voice') return p.voiceAllSegments(scene.id)
  // assemble: render the scene MP4 then save it (both throw on failure).
  const blob = await assembleSceneBlob({ scene, fetchBytes })
  await p.saveSceneCut(scene.id, blob)
}
