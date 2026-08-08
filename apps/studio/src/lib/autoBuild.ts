/**
 * Auto Build (story 03s) — the pure decision layer for the unattended Build run.
 *
 * Auto mode drives every pending scene through the same build steps in order;
 * this module says, from the durable scene state alone, which step a scene is on,
 * what the run should do next, and how to colour each row in the dashboard. It
 * holds NO state of its own — "done" is derived from the same scene fields the
 * manual UI already writes (clipUrl, sheets, refined, assembledUrl, status), so
 * there is never a second source of truth to keep in sync.
 */

import type { Scene } from './scenes'
import { effectiveCuts } from './refiner'

/**
 * The patch to stamp onto any edit that changes a scene's **assemble inputs** —
 * its cuts or its cut clip. Such an edit makes a
 * previously saved render (`assembledUrl`) stale, but the final stitch
 * (`assembleFinalCutBlob`) is a blind stream-copy concat of saved scene clips, so
 * the stale clip would otherwise be re-emitted (e.g. the full 19-min cut after
 * you trimmed it to 10). Clearing `assembledUrl` and returning the scene to
 * `pending` drops the stale bytes, so the assemble step (`nextStep` → `assemble`)
 * and the manual export gate both re-render it before the stitch. Only the
 * rendered output is cleared — `scene.cuts` (the director's immutable baseline)
 * and `scene.refined` (the editable cut layer) are untouched, so reverting or
 * re-refining from the original still works. `useScenePipeline`'s `patchSceneEdit`
 * applies this to every such edit. */
export const STALE_RENDER_PATCH = {
  assembledUrl: undefined,
  status: 'pending',
} as const satisfies Partial<Scene>

/** The per-scene build steps, in the order auto mode runs them. `assemble` covers
 *  both rendering the scene MP4 and saving it (one action). */
export type AutoStepId = 'cut' | 'sheets' | 'refine' | 'assemble'

/** Per-step display status in the dashboard. */
export type AutoStepStatus = 'pending' | 'running' | 'done' | 'error'

/** The run's lifecycle. `paused` = stopped after the current step (resumable);
 *  `halted` = stopped on an error (resumable after the cause is fixed). */
export type AutoRunStatus = 'idle' | 'running' | 'paused' | 'halted' | 'done'

export type AutoHalt = ActiveStep & { message: string }

/** The run state, persisted in the studio slice. `active` is every step
 *  currently executing (the parallel runner's in-flight set, mirrored for the
 *  board); `halt` names the ONE failed step that stopped the run. */
export type AutoBuildRun = {
  status: AutoRunStatus
  active: ActiveStep[]
  halt: AutoHalt | null
}

export type AutoStepDef = {
  id: AutoStepId
  label: string
  /** True when this step's durable output already exists on the scene. */
  isDone: (scene: Scene) => boolean
}

export const AUTO_STEPS: AutoStepDef[] = [
  { id: 'cut', label: 'Cut scene', isDone: (s) => !!s.clipUrl && !!s.clipAudioUrl },
  { id: 'sheets', label: 'Contact sheets', isDone: (s) => (s.sheets?.length ?? 0) > 0 },
  { id: 'refine', label: 'Refine scene', isDone: (s) => !!s.refined },
  { id: 'assemble', label: 'Assemble & save', isDone: (s) => !!s.assembledUrl },
]

/** The first step on this scene that isn't done yet, or null when all are done. */
export function nextStep(scene: Scene): AutoStepId | null {
  for (const step of AUTO_STEPS) if (!step.isDone(scene)) return step.id
  return null
}

/** Whether every build step for this scene is complete (ready to mark built). */
export function isSceneComplete(scene: Scene): boolean {
  return nextStep(scene) === null
}

/**
 * What auto mode should do next across the whole run:
 *  - `{ scene, step }` — run `step` on the first not-yet-built scene, OR
 *  - `{ scene, step: null }` — that scene's steps are all done; mark it built, OR
 *  - `null` — no pending scenes remain; do the final stitch / finish.
 * Built scenes (`status === 'built'`) are skipped.
 */
export function nextAction(scenes: Scene[]): { scene: Scene; step: AutoStepId | null } | null {
  for (const scene of scenes) {
    if (scene.status === 'built') continue
    return { scene, step: nextStep(scene) }
  }
  return null
}

/** One step currently executing. `sceneId: null` only for the final `'stitch'`. */
export type ActiveStep = { sceneId: string | null; stepId: AutoStepId | 'stitch' }

/**
 * Which shared resource each step occupies. cut + assemble both `exec` on the
 * ONE ffmpeg.wasm instance (and the MT core already saturates every CPU core,
 * with a fixed 3 GiB heap), so they share a lane of capacity 1. refine is a
 * server job the browser merely polls; sheets is main-thread canvas capture.
 */
export const STEP_LANE: Record<AutoStepId, 'ffmpeg' | 'refine' | 'sheets'> = {
  cut: 'ffmpeg',
  assemble: 'ffmpeg',
  refine: 'refine',
  sheets: 'sheets',
}

export type AutoAction =
  | { kind: 'step'; scene: Scene; step: AutoStepId }
  | { kind: 'markBuilt'; scene: Scene }
  | { kind: 'stitch' }

/**
 * Every step the run may start RIGHT NOW, given what's already in flight — the
 * parallel generalization of `nextAction`. Walks scenes in order; each scene
 * offers at most its single `nextStep` (the intra-scene cut → sheets → refine
 * → assemble dependency is enforced by derivation, exactly as in the
 * sequential runner). A step is admitted only if:
 *  - its scene has nothing in flight,
 *  - its lane (see `STEP_LANE`) is free — counting both `inFlight` and steps
 *    admitted earlier in this same pass (earlier scene wins the lane),
 *  - for `refine`: every earlier scene is built or already has `refined` — the
 *    seam-context ordering (story 03r: scene N's refine reads scene N−1's
 *    refined tail).
 * `markBuilt` is instant bookkeeping, never lane-capped. `stitch` is offered
 * only when no scene work remains AND nothing is in flight (it concats every
 * scene's saved cut).
 */
export function nextActions(scenes: Scene[], inFlight: ActiveStep[]): AutoAction[] {
  const busyLanes = new Set(
    inFlight
      .filter((a): a is ActiveStep & { stepId: AutoStepId } => a.stepId !== 'stitch')
      .map((a) => STEP_LANE[a.stepId]),
  )
  const busyScenes = new Set(inFlight.map((a) => a.sceneId))
  const actions: AutoAction[] = []
  let sceneWorkRemains = false

  for (const [i, sc] of scenes.entries()) {
    if (sc.status === 'built') continue
    sceneWorkRemains = true
    const step = nextStep(sc)
    if (step === null) {
      if (!busyScenes.has(sc.id)) actions.push({ kind: 'markBuilt', scene: sc })
      continue
    }
    if (busyScenes.has(sc.id)) continue
    if (step === 'refine' && !scenes.slice(0, i).every((p) => p.status === 'built' || !!p.refined))
      continue
    const lane = STEP_LANE[step]
    if (busyLanes.has(lane)) continue
    busyLanes.add(lane)
    actions.push({ kind: 'step', scene: sc, step })
  }

  if (!sceneWorkRemains && inFlight.length === 0) actions.push({ kind: 'stitch' })
  return actions
}

/** Per-step display status for one scene, given the live run state. */
export function sceneStepStatuses(scene: Scene, run: AutoBuildRun): Record<AutoStepId, AutoStepStatus> {
  const status = (step: AutoStepDef): AutoStepStatus => {
    if (step.isDone(scene)) return 'done'
    if (run.status === 'halted' && run.halt?.sceneId === scene.id && run.halt.stepId === step.id)
      return 'error'
    if (run.status === 'running' && run.active.some((a) => a.sceneId === scene.id && a.stepId === step.id))
      return 'running'
    return 'pending'
  }
  return Object.fromEntries(AUTO_STEPS.map((step) => [step.id, status(step)])) as Record<
    AutoStepId,
    AutoStepStatus
  >
}

/**
 * Is this halt pointing at work that has since been done?
 *
 * A halt is a claim about ONE step: "`halt.stepId` on `halt.sceneId` failed".
 * Like every other Auto Build reading, that claim is only as durable as the scene
 * state underneath it — and the producer can satisfy the step by hand (assemble +
 * save the scene from `SceneAssembleBar`, cut it, mark it built). Once they have,
 * the halt describes nothing: the run is simply stopped, and the board should say
 * `⏸ Paused` rather than keep flying `✗ Halted` and a stale network error over a
 * scene that now reads `✓ built` (issue #220). The runner clears it on sight.
 *
 * This is the derived-state rule the module doc promises, applied to the failed
 * step too — no second source of truth, not even for failure.
 */
export function isHaltStale(
  scenes: Scene[],
  run: AutoBuildRun,
  finalCutUrl: string | null,
): boolean {
  if (run.status !== 'halted' || !run.halt) return false
  if (run.halt.stepId === 'stitch') return !!finalCutUrl
  const scene = scenes.find((s) => s.id === run.halt!.sceneId)
  if (!scene) return false
  if (scene.status === 'built') return true
  const step = AUTO_STEPS.find((s) => s.id === run.halt!.stepId)
  return !!step && step.isDone(scene)
}

/**
 * A fingerprint of everything `assembleSceneBlob` reads to render this scene: its
 * cut clip and its effective cuts. Two scenes with the same key render to the same
 * MP4, so a render cached under this key stays valid — and any edit that would
 * make it stale (a re-slice, a refine, a hand-edited cut) changes the key, which is
 * what lets the runner reuse a render after a failed SAVE without ever uploading
 * bytes that no longer match the timeline.
 */
export function assembleInputsKey(scene: Scene): string {
  return JSON.stringify([scene.clipUrl ?? null, effectiveCuts(scene)])
}

/** Rolled-up status for a scene row in the dashboard. */
export function sceneRunStatus(
  scene: Scene,
  run: AutoBuildRun,
): 'built' | 'error' | 'running' | 'pending' {
  if (scene.status === 'built') return 'built'
  if (run.status === 'halted' && run.halt?.sceneId === scene.id) return 'error'
  if (run.status === 'running' && run.active.some((a) => a.sceneId === scene.id)) return 'running'
  return 'pending'
}
