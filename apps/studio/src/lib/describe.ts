/**
 * Export description (the "finished product" page).
 *
 * Once every scene is built, the Export step shows the video's key info: a
 * recommended TITLE and a SUMMARY written by `/api/describe`, the chapter
 * timestamps of the final cut, and the full spoken script. Crucially the title +
 * summary are written from the **kept narration** (what actually survived the
 * cuts), with the director's `synopsis` as context — NOT the original transcript,
 * which describes the uncut talk.
 *
 * This is the pure half — request shaping, the chapter/script derivations, and
 * the tolerant response coercion — shared by the MSW mock and the real pipeline
 * (which also coerces server-side; this is the client mirror, like `director.ts`).
 */

import type { Scene } from './scenes'
import { sceneVideoSeconds } from './scenes'
import { effectiveCuts, effectiveSegments, normalizeCuts } from './refiner'

/** The request body POSTed to `/api/describe`: the final kept script + the
 *  director's take, both as context for the title/summary. */
export type DescribeRequest = { script: string; synopsis: string }

/** The model's output: a recommended title and a summary of the finished video. */
export type VideoDescription = { title: string; summary: string }

/** One chapter of the final cut — its start time (assembled-timeline seconds)
 *  and the scene's title. */
export type Chapter = { time: number; title: string }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * The spoken script of the FINISHED video: every scene's effective narration
 * runs, in order, joined into one block (a blank line between scenes). This is
 * what survives the cuts — not the original transcript — so it's what we
 * summarize and show.
 */
export function videoScript(scenes: Scene[]): string {
  return scenes
    .map((s) => {
      // Read `refined.segments` directly when refined — `effectiveSegments` falls
      // back to a phantom transcript when the segments are EMPTY (a fully-cut
      // scene), which would leak the uncut talk into the final script.
      const segs = s.refined ? s.refined.segments : effectiveSegments(s)
      return segs
        .map((seg) => seg.text.trim())
        .filter(Boolean)
        .join(' ')
        .trim()
    })
    .filter(Boolean)
    .join('\n\n')
}

/** A scene's length in the FINAL cut: footage minus the effective cuts. Matches
 *  the "Final clip" stat in SceneMeta and what the assembler renders. */
function finalSceneSeconds(scene: Scene): number {
  const dropped = normalizeCuts(effectiveCuts(scene)).reduce(
    (n, c) => n + Math.max(0, c.end - c.start),
    0,
  )
  return Math.max(0, sceneVideoSeconds(scene) - dropped)
}

/**
 * Chapter markers for the whole video: each scene is a chapter whose start is the
 * cumulative final length of the scenes before it (the same order the final cut
 * concatenates them).
 */
export function videoChapters(scenes: Scene[]): Chapter[] {
  const out: Chapter[] = []
  let t = 0
  for (const s of scenes) {
    out.push({ time: t, title: s.title })
    t += finalSceneSeconds(s)
  }
  return out
}

/** "M:SS" for a chapter time. */
export function chapterTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The chapter list as YouTube-style lines: "0:00 Title". */
export function formatChapters(chapters: Chapter[]): string {
  return chapters.map((c) => `${chapterTime(c.time)} ${c.title}`).join('\n')
}

/**
 * The final kept narration as a flat word list with interpolated timestamps —
 * the shape `TranscriptText` renders, so the Export page can show the script in
 * the SAME treatment as the prep transcript. Each segment's words are spread
 * evenly across its `[start, end]` span (original-video seconds).
 */
export function scriptWords(scenes: Scene[]): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = []
  for (const scene of scenes) {
    const segs = scene.refined ? scene.refined.segments : effectiveSegments(scene)
    for (const seg of segs) {
      const words = seg.text.trim().split(/\s+/).filter(Boolean)
      if (words.length === 0) continue
      const per = Math.max(0.01, seg.end - seg.start) / words.length
      words.forEach((w, i) => out.push({ text: w, start: seg.start + i * per, end: seg.start + (i + 1) * per }))
    }
  }
  return out
}

/**
 * The YouTube-ready description block: the AI summary, then the chapter lines
 * ("0:00 Title") YouTube turns into chapters. Either part may be empty. Shared by
 * the Export summary view and the thumbnail generator (which feeds it to the
 * prompt-drafting handler as DESCRIPTION).
 */
export function youtubeDescription(summary: string | null | undefined, chapters: Chapter[]): string {
  return [summary, formatChapters(chapters)].filter(Boolean).join('\n\n')
}

/** Build the `/api/describe` request — the final script + the director's take. */
export function buildDescribeRequest(scenes: Scene[], synopsis: string | null): DescribeRequest {
  return { script: videoScript(scenes), synopsis: (synopsis ?? '').trim() }
}

/**
 * Coerce the model's raw output into a clean `{ title, summary }`. Accepts the
 * object directly (or a tolerant fallback); trims strings; never throws.
 */
export function toDescription(raw: unknown): VideoDescription {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { title: str(o.title), summary: str(o.summary) }
}
