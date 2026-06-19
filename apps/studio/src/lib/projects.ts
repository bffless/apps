/**
 * Pure project-model helpers (story 11a). The studio slice holds a keyed
 * collection of projects; these helpers derive the dashboard metadata (phase,
 * thumbnail) from a project's working state and name new projects. They are pure
 * — NO id minting lives here (that's impure and belongs in the reducer).
 *
 * Cycle avoidance: `studioSlice.ts` type-imports `ProjectMeta` from here; this
 * module only type-imports `ProjectWorkingState` from the slice, so there is no
 * runtime cycle.
 */

import type { ProjectWorkingState } from '../store/studioSlice'
import { GLOBAL_STAGES, PER_VIDEO_STAGES, studioPhase, type StudioPhase } from './pipeline'

/** Lightweight per-project metadata for the dashboard index (no heavy working state). */
export type ProjectMeta = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  phase: StudioPhase
  thumbnailUrl: string | null
}

export const DEFAULT_PROJECT_NAME = 'Untitled project'

/** Which macro phase a project is in, derived purely from its working state. */
export function phaseOf(w: ProjectWorkingState): StudioPhase {
  const hasSource = w.sources.length > 0
  const allBuilt = w.scenes.length > 0 && w.scenes.every((s) => s.status === 'built')
  const sourcesReady =
    w.sources.length > 0 &&
    w.sources.every((s) => PER_VIDEO_STAGES.every((id) => s.stageProgress[id]?.status === 'done'))
  const ready = sourcesReady && GLOBAL_STAGES.every((id) => w.stageProgress[id]?.status === 'done')
  return studioPhase({ hasSource, ready, allBuilt })
}

/** The dashboard-facing derived fields (phase + thumbnail) for one project.
 *  Prefer the generated YouTube thumbnail (the finished, on-brand image) once it
 *  exists; fall back to the first contact sheet otherwise. Both are unsigned
 *  `/api/uploads/...` serve paths shown directly on the card. */
export function deriveProjectMeta(w: ProjectWorkingState): Pick<ProjectMeta, 'phase' | 'thumbnailUrl'> {
  const thumbnailUrl =
    w.youtubeThumbnail?.url || w.contactSheets.find((s) => s.url)?.url || null
  return { phase: phaseOf(w), thumbnailUrl }
}

/** The next collision-free "Untitled project" name given the existing names. */
export function nextUntitledName(existing: string[]): string {
  if (!existing.includes(DEFAULT_PROJECT_NAME)) return DEFAULT_PROJECT_NAME
  let n = 2
  while (existing.includes(`${DEFAULT_PROJECT_NAME} ${n}`)) n++
  return `${DEFAULT_PROJECT_NAME} ${n}`
}
