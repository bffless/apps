/**
 * Thumbnail generator (Export-phase YouTube thumbnail).
 *
 * Two steps: `/api/thumbnail/draft` drafts a nano-banana image prompt from the
 * video's title/description/final-script + the creator's notes (the AI handler
 * loads the `image-prompts` skill to do the actual prompt-craft), and
 * `/api/thumbnail/render` calls `google/nano-banana` with the (edited) prompt and
 * stores the image to the bucket. This is the pure half — request shaping + the
 * tolerant response coercion shared by the MSW mock and the real pipeline (which
 * also coerces server-side; this is the client mirror, like `describe.ts`).
 */

import type { Scene } from './scenes'
import { videoScript, type SceneWords } from './describe'

// Lives in `slug.ts` now, alongside `finalCutFileName` — one slug rule for every
// download name. Re-exported so existing importers keep their import path.
export { thumbnailFileName } from './slug'

/** POSTed to `/api/thumbnail/draft`: everything the prompt-drafting handler needs. */
export type ThumbnailDraftRequest = {
  /** The video's recommended title. */
  title: string
  /** The YouTube-ready description block (summary + chapters). */
  description: string
  /** The FINAL kept spoken script — evidence for topic + house-style routing. */
  script: string
  /** The creator's free-text wishes; overrides style routing when present. */
  notes: string
}

/** The draft handler's output: the ready-to-paste image prompt. */
export type ThumbnailPrompt = { prompt: string }

/** The render step's output: the persisted `/api/uploads/...` serve path. */
export type ThumbnailImage = { imageUrl: string }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Build the `/api/thumbnail/draft` request from the project's Export-page data. */
export function buildThumbnailDraftRequest(
  scenes: Scene[],
  title: string,
  description: string,
  notes: string,
  wordsFor: SceneWords,
): ThumbnailDraftRequest {
  return {
    title: title.trim(),
    description: description.trim(),
    script: videoScript(scenes, wordsFor),
    notes: notes.trim(),
  }
}

/** Coerce the draft handler's raw reply into `{ prompt }`; never throws. */
export function toThumbnailPrompt(raw: unknown): ThumbnailPrompt {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { prompt: str(o.prompt) }
}

/** Coerce the render step's raw reply into `{ imageUrl }`; never throws. */
export function toThumbnailImage(raw: unknown): ThumbnailImage {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { imageUrl: str(o.imageUrl) }
}
