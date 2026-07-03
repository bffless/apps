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
import { effectiveCuts, keptWords, normalizeCuts } from './refiner'
import type { TWord } from './transcriptGrid'

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
 * Resolves a scene to its timed words — the slice of its source's transcript
 * that overlaps the scene window. Callers build one with `sceneWordsLookup`;
 * the indirection keeps this module pure while scenes only carry a `sourceId`.
 */
export type SceneWords = (scene: Scene) => TWord[]

/** The standard `SceneWords` over the project's sources (story 09a shape). */
export function sceneWordsLookup(sources: { id: string; words?: TWord[] }[]): SceneWords {
  return (scene) =>
    (sources.find((s) => s.id === scene.sourceId)?.words ?? []).filter(
      (w) => w.start < scene.end && w.end > scene.start,
    )
}

/**
 * The spoken script of the FINISHED video: every scene's kept words (its timed
 * words minus the effective cuts — ADR-0003: what the viewer hears IS the
 * original speech that survives), in order, a blank line between scenes. A
 * scene with no timed words (old restored data) falls back to its raw
 * transcript — uncut, but better than dropping the scene from the summary.
 */
export function videoScript(scenes: Scene[], wordsFor: SceneWords): string {
  return scenes
    .map((s) => {
      const words = wordsFor(s)
      if (!words.length) return s.transcript.trim()
      return keptWords(words, effectiveCuts(s))
        .map((w) => w.text.trim())
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
 * The final kept script as a flat word list — the shape `TranscriptText`
 * renders, so the Export page can show the script in the SAME treatment as the
 * prep transcript. These are the scene's real transcribed words (real
 * timestamps, original-video seconds) minus the effective cuts.
 */
export function scriptWords(scenes: Scene[], wordsFor: SceneWords): TWord[] {
  return scenes.flatMap((scene) => keptWords(wordsFor(scene), effectiveCuts(scene)))
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
export function buildDescribeRequest(
  scenes: Scene[],
  synopsis: string | null,
  wordsFor: SceneWords,
): DescribeRequest {
  return { script: videoScript(scenes, wordsFor), synopsis: (synopsis ?? '').trim() }
}

/**
 * Coerce the model's raw output into a clean `{ title, summary }`. Accepts the
 * object directly (or a tolerant fallback); trims strings; never throws.
 */
export function toDescription(raw: unknown): VideoDescription {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return { title: str(o.title), summary: str(o.summary) }
}
