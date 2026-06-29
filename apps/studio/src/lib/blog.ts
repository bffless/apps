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
import { globalToLocal, type SourceLike } from './sources'

/** One scene's heading + the words spoken in it, the outline the live `/api/blog`
 *  rule seeds the post's sections from (it may merge/rename for flow). */
export type BlogScene = { title: string; transcript: string }

/**
 * The request body POSTed to `/api/blog`. The `script` (final kept narration) is
 * the staleness key for the stored post; the rest is the faithful-prose context
 * the live multimodal rule builds its prompt from (story 69): the recommended
 * `title` + `summary`, the director `synopsis`, the per-scene `{ title, transcript }`
 * outline, the `timedTranscript` (the original recording bucketed into `[m:ss]`
 * lines — the SAME timestamped transcript the director gets, so the model can
 * align what's said to WHEN and pick accurate `frame:<t>` image timestamps), the
 * creator's `direction`, the signed Contact-sheet `sheetUrls` (the model's visual
 * context, signed step-by-step server-side), and the `duration`.
 */
export type BlogRequest = {
  script: string
  timedTranscript: string
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
  /** The original recording as `[m:ss] words` lines (see `combinedTimedTranscript`)
   *  — the model's text↔time bridge for choosing image `frame:<t>` timestamps. */
  timedTranscript?: string | null
}

/** The model's output: one Markdown document (front-matter + prose). */
export type BlogResult = { markdown: string }

/** The stored-post fields staleness depends on — a structural subset of the
 *  slice's `BlogPost`, so this pure module stays free of a store import. */
export type StoredBlogPost = { markdown: string; script: string; status: string }

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
    timedTranscript: trim(ctx.timedTranscript),
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

// ---- Inline frame images (issue #70) --------------------------------------
//
// The live `/api/blog` rule places images in the prose as inline tokens keyed by
// the global-timeline timestamp it read off a Contact-sheet's burned-in clock,
// e.g. `![A diff of the rule](frame:142.5)`. These pure helpers turn those tokens
// into real, uploaded images: parse + dedup the timestamps, map each global time
// back to its owning source's local time (ADR-0002 re-captures a clean frame from
// the source — never crops the contact sheet), and finally rewrite each token to
// the bucket serve URL the captured frame was uploaded to. The capture + upload
// itself lives in the orchestrator; everything string-shaped lives here, tested.

/** A `![caption](frame:<t>)` token found in the generated Markdown: the global
 *  timestamp (seconds), its caption (alt text), and the exact substring matched
 *  (so a rewrite can replace each occurrence in place). */
export type FrameToken = { time: number; caption: string; raw: string }

/** One frame to re-capture and upload: the deduped global timestamp resolved to
 *  its owning `(sourceId, localTime)` plus the `frame-NN.jpg` name it uploads as. */
export type BlogFrameCapture = {
  time: number
  sourceId: string
  localTime: number
  fileName: string
}

/** Matches an inline image whose URL is a `frame:<t>` token. The timestamp group
 *  is captured raw (validated by the caller) so a malformed token still matches —
 *  the rewrite can then strip it rather than leave a broken image in the post. */
const FRAME_TOKEN = /!\[([^\]]*)\]\(\s*frame:\s*([^)\s]*)\s*\)/g

/** The bucket object name for the Nth (1-based) blog frame: `frame-01.jpg`. */
export function frameFileName(index: number): string {
  return `frame-${String(index).padStart(2, '0')}.jpg`
}

/**
 * Parse every `![caption](frame:<t>)` token in document order. A token whose
 * timestamp isn't a finite, non-negative number is skipped (it never becomes an
 * image), so a malformed token degrades to nothing rather than a broken post.
 */
export function parseFrameTokens(markdown: string): FrameToken[] {
  const out: FrameToken[] = []
  for (const m of str(markdown).matchAll(FRAME_TOKEN)) {
    if (m[2] === '') continue // `frame:` with no timestamp — `Number('')` is 0, not a real time
    const time = Number(m[2])
    if (!Number.isFinite(time) || time < 0) continue
    out.push({ time, caption: m[1].trim(), raw: m[0] })
  }
  return out
}

/**
 * Plan the frames to capture for a post: parse the tokens, **dedup by timestamp**
 * (one capture/upload per unique moment, even if the model reuses a frame), then
 * map each global timestamp back to its owning `(sourceId, localTime)` via the
 * project's source timeline — so a multi-source project captures from the correct
 * video (ADR-0002 / story 09). Captures are numbered `frame-01.jpg…` in
 * first-appearance order; a timestamp that can't be routed to a source (no
 * sources) is dropped.
 */
export function planBlogCaptures(markdown: string, sources: SourceLike[]): BlogFrameCapture[] {
  const seen = new Map<number, BlogFrameCapture>()
  for (const token of parseFrameTokens(markdown)) {
    if (seen.has(token.time)) continue
    const loc = globalToLocal(sources, token.time)
    if (!loc) continue
    seen.set(token.time, {
      time: token.time,
      sourceId: loc.sourceId,
      localTime: loc.localTime,
      fileName: frameFileName(seen.size + 1),
    })
  }
  return [...seen.values()]
}

/**
 * Rewrite every `frame:<t>` token to a real Markdown image at the bucket serve
 * URL its captured frame was uploaded to (`urlByTime`, keyed by global timestamp).
 * A token whose timestamp has no URL — because the capture or upload failed, or
 * the timestamp was malformed — is **dropped entirely**, so a raw `frame:` token
 * (or a broken image) never survives into the rendered/downloaded post. The
 * caption is preserved as the image's alt text (the preview surfaces it visibly).
 */
export function rewriteFrameTokens(markdown: string, urlByTime: Map<number, string>): string {
  return str(markdown).replace(FRAME_TOKEN, (_raw, caption: string, rawTime: string) => {
    const time = Number(rawTime)
    const url = Number.isFinite(time) ? urlByTime.get(time) : undefined
    if (!url) return ''
    return `![${str(caption).trim()}](${url})`
  })
}

/**
 * A URL/filename-safe slug of the post title — lowercased, every run of
 * non-alphanumerics collapsed to a single hyphen, trimmed. Used to name the
 * downloadable bundle (`<slug>.zip`, story 12 / issue #71); falls back to `post`
 * when the title is empty or punctuation-only.
 */
export function blogSlug(title: string): string {
  const slug = str(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'post'
}

// ---- Download bundle (issue #71) ------------------------------------------
//
// The Blog bundle is the portable deliverable: a single zip containing `post.md`
// plus an `images/` folder, self-contained so it renders wherever the creator
// unzips it (Studio never hosts it). The persisted Markdown points its images at
// the bucket serve URLs the frames were uploaded to (`rewriteFrameTokens`); the
// bundle re-homes them to relative `images/frame-NN.jpg` paths. This pure half
// plans the bundle — the rewritten Markdown plus the ordered list of frames to
// fetch — and the imperative half (fetch each frame, zip, download) lives in the
// card; everything string-shaped is here, tested.

/** One file the bundle's `images/` folder holds: the relative `path` written into
 *  both the zip and the rewritten Markdown, and the `url` to fetch its bytes from. */
export type BlogBundleImage = { path: string; url: string }

/** The plan for assembling a Blog bundle: the zip's name (`<slug>.zip`), the
 *  Markdown file (`post.md`) with image URLs rewritten to relative paths and
 *  front-matter preserved, and the ordered, deduped images to fetch into it. */
export type BlogBundlePlan = {
  archiveName: string
  markdownPath: string
  markdown: string
  images: BlogBundleImage[]
}

/** Matches a Markdown image `![alt](url)` whose URL has no whitespace (the bucket
 *  serve paths the frames upload to). */
const MD_IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g

/**
 * Plan the Blog bundle from the resolved post Markdown and its title. Every image
 * URL is rewritten to a relative `images/frame-NN.jpg` path (numbered by first
 * appearance, **deduped by URL** so a frame reused twice is bundled once) and the
 * front-matter is left untouched; the returned `images` list pairs each relative
 * path with the URL to fetch its bytes from. A stray unresolved `frame:` token —
 * one that never became a real image — is left as-is and never bundled, so a bad
 * token can't pull a missing file into the archive.
 */
export function planBlogBundle(markdown: string, title: string): BlogBundlePlan {
  const pathByUrl = new Map<string, string>()
  const images: BlogBundleImage[] = []
  const rewritten = str(markdown).replace(MD_IMAGE, (raw, caption: string, url: string) => {
    if (url.startsWith('frame:')) return raw // unresolved token — not a real image
    let path = pathByUrl.get(url)
    if (!path) {
      path = `images/${frameFileName(images.length + 1)}`
      pathByUrl.set(url, path)
      images.push({ path, url })
    }
    return `![${caption}](${path})`
  })
  return { archiveName: `${blogSlug(title)}.zip`, markdownPath: 'post.md', markdown: rewritten, images }
}

/**
 * Has the final script drifted from what a generated post was written against?
 * The post stores the `script` it came from (its staleness key); when the
 * producer re-cuts a scene the final script changes, and the card flags the post
 * stale so they can regenerate on demand — it is NEVER auto-regenerated. Only a
 * finished post (`status: 'done'` with markdown) can be stale; a still-running,
 * idle, errored, or never-generated post is not. Whitespace-insensitive, so a
 * cosmetic trim of the script doesn't read as a real change.
 */
export function isBlogStale(post: StoredBlogPost | null | undefined, currentScript: string): boolean {
  if (!post || post.status !== 'done' || !post.markdown.trim()) return false
  return currentScript.trim() !== post.script.trim()
}
