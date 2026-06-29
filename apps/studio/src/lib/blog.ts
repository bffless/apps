/**
 * Blog post generation (the Export step's "write it up" card).
 *
 * Once the final cut is built, the producer can generate a Markdown blog post
 * from the FINISHED video's narration — the same kept script the description is
 * written from — plus a free-text direction. This is the pure half: request
 * shaping and the tolerant response coercion, shared by the MSW mock and the
 * eventual live `/api/blog` pipeline (which also coerces server-side; this is the
 * client mirror, like `director.ts` / `describe.ts`).
 *
 * In this slice the post is text-only `{ markdown }`; the inline `frame:<t>`
 * image tokens it may contain are rendered as raw text — capturing/uploading the
 * real frames is a later story.
 */

import type { Scene } from './scenes'
import { videoScript } from './describe'

/** The request body POSTed to `/api/blog`: the final kept script (the staleness
 *  key for the stored post) and the creator's free-text direction. */
export type BlogRequest = { script: string; direction: string }

/** The model's output: one Markdown document (front-matter + prose). */
export type BlogResult = { markdown: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Build the `/api/blog` request — the final kept narration (so the post tracks
 * what actually shipped, not the uncut talk) plus the creator's direction.
 */
export function buildBlogRequest(scenes: Scene[], direction: string): BlogRequest {
  return { script: videoScript(scenes), direction: (direction ?? '').trim() }
}

/**
 * Coerce the model's raw output into a clean `{ markdown }`. Accepts the object
 * directly (`{ markdown }`), a bare Markdown string, or a tolerant fallback;
 * trims trailing whitespace; never throws. Shared by the mock and the real
 * pipeline so swap-don't-rewrite holds.
 */
export function toBlog(raw: unknown): BlogResult {
  if (typeof raw === 'string') return { markdown: raw.trim() }
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { markdown: str(o.markdown).trim() }
}
