/**
 * Auto Build (story 03s) — the pure decision layer for the unattended Build run.
 *
 * Auto mode drives every pending scene through the same build steps in order;
 * this module says, from the durable scene state alone, which step a scene is on,
 * what the run should do next, and how to colour each row in the dashboard. It
 * holds NO state of its own — "done" is derived from the same scene fields the
 * manual UI already writes (clipUrl, sheets, refined, segment audio, assembledUrl,
 * status), so there is never a second source of truth to keep in sync.
 */

import type { Scene } from './scenes'

/**
 * The patch to stamp onto any edit that changes a scene's **assemble inputs** —
 * its cuts, its narration segments' audio, or its cut clip. Such an edit makes a
 * previously saved render (`assembledUrl`) stale, but the final stitch
 * (`assembleFinalCutBlob`) is a blind stream-copy concat of saved scene clips, so
 * the stale clip would otherwise be re-emitted (e.g. the full 19-min cut after
 * you trimmed it to 10). Clearing `assembledUrl` and returning the scene to
 * `pending` drops the stale bytes, so the assemble step (`nextStep` → `assemble`)
 * and the manual export gate both re-render it before the stitch. Only the
 * rendered output is cleared — `scene.cuts` (the director's immutable baseline)
 * and `scene.refined` (the editable script) are untouched, so reverting or
 * re-refining from the original still works. `useScenePipeline`'s `patchSceneEdit`
 * applies this to every such edit. */
export const STALE_RENDER_PATCH = {
  assembledUrl: undefined,
  status: 'pending',
} as const satisfies Partial<Scene>

/** The per-scene build steps, in the order auto mode runs them. `assemble` covers
 *  both rendering the scene MP4 and saving it (one action). */
export type AutoStepId = 'cut' | 'sheets' | 'refine' | 'voice' | 'assemble'

/** Per-step display status in the dashboard. */
export type AutoStepStatus = 'pending' | 'running' | 'done' | 'error'

/** The run's lifecycle. `paused` = stopped after the current step (resumable);
 *  `halted` = stopped on an error (resumable after the cause is fixed). */
export type AutoRunStatus = 'idle' | 'running' | 'paused' | 'halted' | 'done'

/** The run pointer, persisted in the studio slice. `currentStepId` is widened with
 *  'stitch' for the project-level final concat that runs after the last scene. */
export type AutoBuildRun = {
  status: AutoRunStatus
  currentSceneId: string | null
  currentStepId: AutoStepId | 'stitch' | null
  error: string | null
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
  {
    id: 'voice',
    label: 'Voice segments',
    // Only meaningful once refined. We check `refined.segments` directly (not
    // effectiveSegments) because effectiveSegments falls back to the raw
    // transcript when refined.segments is empty — which would leave an unvoiced
    // phantom. An empty refined segment list is vacuously "all voiced".
    isDone: (s) => !!s.refined && s.refined.segments.every((seg) => !!seg.audioUrl),
  },
  { id: 'assemble', label: 'Assemble & save', isDone: (s) => !!s.assembledUrl },
]

/** Voiced/total segment counts for the dashboard's "Voice (n/m)" sub-progress.
 *  Reads `refined.segments` (the same source as the voice step) so it never shows
 *  a phantom count on a not-yet-refined scene. */
export function voiceProgress(scene: Scene): { done: number; total: number } {
  const segs = scene.refined?.segments ?? []
  return { done: segs.filter((s) => !!s.audioUrl).length, total: segs.length }
}

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

/** Per-step display status for one scene, given the live run pointer. */
export function sceneStepStatuses(scene: Scene, run: AutoBuildRun): Record<AutoStepId, AutoStepStatus> {
  const status = (step: AutoStepDef): AutoStepStatus => {
    if (step.isDone(scene)) return 'done'
    if (run.currentSceneId === scene.id && run.currentStepId === step.id)
      return run.status === 'halted' ? 'error' : run.status === 'running' ? 'running' : 'pending'
    return 'pending'
  }
  return Object.fromEntries(AUTO_STEPS.map((step) => [step.id, status(step)])) as Record<
    AutoStepId,
    AutoStepStatus
  >
}

/** Rolled-up status for a scene row in the dashboard. */
export function sceneRunStatus(
  scene: Scene,
  run: AutoBuildRun,
): 'built' | 'error' | 'running' | 'pending' {
  if (scene.status === 'built') return 'built'
  if (run.currentSceneId === scene.id) {
    if (run.status === 'halted') return 'error'
    if (run.status === 'running') return 'running'
  }
  return 'pending'
}
