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
import { videoScript } from './describe'

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
): ThumbnailDraftRequest {
  return {
    title: title.trim(),
    description: description.trim(),
    script: videoScript(scenes),
    notes: notes.trim(),
  }
}

/** Coerce the draft handler's raw reply into `{ prompt }`; never throws. */
export function toThumbnailPrompt(raw: unknown): ThumbnailPrompt {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { prompt: str(o.prompt) }
}

/**
 * A snake_cased download filename derived from the video title, e.g.
 * "Overview of Onboarding Rules" → "overview_of_onboarding_rules.jpg".
 * Collapses any run of non-alphanumeric characters to a single underscore and
 * trims leading/trailing ones; falls back to "thumbnail" when the title is
 * empty or punctuation-only.
 */
export function thumbnailFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${slug || 'thumbnail'}.jpg`
}

/** Coerce the render step's raw reply into `{ imageUrl }`; never throws. */
export function toThumbnailImage(raw: unknown): ThumbnailImage {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { imageUrl: str(o.imageUrl) }
}
