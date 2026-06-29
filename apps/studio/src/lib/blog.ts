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
import type { VideoDescription } from './describe'
import { videoScript } from './describe'

/** One scene's heading + the words spoken in it, the outline the live `/api/blog`
 *  rule seeds the post's sections from (it may merge/rename for flow). */
export type BlogScene = { title: string; transcript: string }

/**
 * The request body POSTed to `/api/blog`. The `script` (final kept narration) is
 * the staleness key for the stored post; the rest is the faithful-prose context
 * the live multimodal rule builds its prompt from (story 69): the recommended
 * `title` + `summary`, the director `synopsis`, the per-scene `{ title, transcript }`
 * outline, the creator's `direction`, the signed Contact-sheet `sheetUrls` (the
 * model's visual context, signed step-by-step server-side), and the `duration`.
 */
export type BlogRequest = {
  script: string
  direction: string
  title: string
  summary: string
  synopsis: string
  scenes: BlogScene[]
  sheetUrls: string[]
  duration: number
}

/** The extra context the Export step has on hand when generating the post — the
 *  director synopsis, the recommended title/summary, the Contact-sheet serve URLs,
 *  and the finished duration. All optional: the post stays faithful to whatever is
 *  present (a post can be generated before a description exists). */
export type BlogContext = {
  synopsis?: string | null
  description?: VideoDescription | null
  sheetUrls?: (string | null | undefined)[]
  duration?: number
}

/** The model's output: one Markdown document (front-matter + prose). */
export type BlogResult = { markdown: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const trim = (v: unknown): string => str(v).trim()

/**
 * Build the `/api/blog` request — the final kept narration (so the post tracks
 * what actually shipped, not the uncut talk), the creator's direction, and the
 * faithful-prose context (title, summary, synopsis, per-scene outline, signed
 * sheet URLs, duration) the live rule weaves into its prompt. Everything is
 * trimmed; missing context degrades to empty, never invented.
 */
export function buildBlogRequest(
  scenes: Scene[],
  direction: string,
  ctx: BlogContext = {},
): BlogRequest {
  return {
    script: videoScript(scenes),
    direction: trim(direction),
    title: trim(ctx.description?.title),
    summary: trim(ctx.description?.summary),
    synopsis: trim(ctx.synopsis),
    scenes: scenes.map((s) => ({ title: trim(s.title), transcript: trim(s.transcript) })),
    sheetUrls: (ctx.sheetUrls ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0),
    duration: typeof ctx.duration === 'number' && Number.isFinite(ctx.duration) ? ctx.duration : 0,
  }
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
