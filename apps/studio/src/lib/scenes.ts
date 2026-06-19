/**
 * Scenes — the producer's unit of work. After transcription the AI splits the
 * talk into logical "micro-chapters" (target 2–5 min, but it shouldn't cut a
 * good continuous run just to hit a number). Each scene doubles as a YouTube
 * chapter and as a thing you build one at a time: edit its text, regenerate the
 * cloned-voice narration, and check the narration length lines up with the
 * scene's video length before moving on.
 *
 * Pure + unit-tested. The mock `buildScenes` here is replaced later by the real
 * AI segmentation response (same `Scene` shape).
 */

import type { ContactSheet } from './frames'

export type SceneStatus = 'pending' | 'built'

/**
 * A span of the scene's footage the director says to drop. Bounds are in
 * original-video seconds and always sit inside the owning scene's `start`–`end`.
 * The Build step applies these when it fits the footage to the narration.
 */
export type Cut = { start: number; end: number }

/**
 * One anchored run of the new narration, in original-video seconds. The master
 * director hands us no script — just a per-scene `refinePrompt` (story 03q); the
 * per-scene refiner (story 03c) returns these — where each run of the rewritten
 * script actually starts/ends, split into multiple segments when there's kept
 * dead air/pause between them.
 */
export type NarrationSegment = {
  text: string
  start: number
  end: number
  /** Persisted serve path of this run's narration (story 03c), once voiced.
   *  Absent until generated/recorded. */
  audioUrl?: string
  /** Real measured length of that audio clip, in seconds. */
  audioSeconds?: number
  /** How this run was voiced: AI text-to-speech, the user's own recording, or a
   *  slice of the source clip's ORIGINAL audio dropped back into the new edit
   *  (story 03d — "use the original audio here", no re-voicing). */
  audioSource?: 'ai' | 'recorded' | 'original'
  /** The refiner's per-segment suggestion (story 03j): voice this run with the
   *  span's own ORIGINAL audio, or re-voice its (new) text. Pure provenance —
   *  it survives user overrides, so revert/re-open flows can still show what
   *  the AI wanted. `audioSource` above stays "what actually happened". */
  suggestedSource?: 'original' | 'revoice'
  /** Producer's per-segment voice override (story 10d). Absent = use the segment's
   *  speaker-derived default. Persists on `scene.refined` like every Build edit. */
  voiceId?: string
}

/**
 * The second-pass refiner's output for a scene (story 03c) — kept in a SEPARATE
 * field so the master director's first-pass `cuts` are never overwritten and the
 * producer can revert (`refined = null`). `source` distinguishes the AI's
 * refinement from later hand-edits in the diff viewer.
 */
export type SceneRefinement = {
  segments: NarrationSegment[]
  cuts: Cut[]
  source: 'ai' | 'manual'
}

export type Scene = {
  id: string
  index: number
  /** The source video this chapter belongs to (story 09a). `start`/`end` are
   *  LOCAL to this source's timeline. Every scene belongs to exactly one source;
   *  a chapter never spans a video boundary (the director coercion splits it). */
  sourceId: string
  title: string
  /** Original-timeline bounds, in seconds. */
  start: number
  end: number
  /** The words the AI heard in this scene (read-only reference). */
  transcript: string
  status: SceneStatus
  /** Length of the generated narration once voiced; null until voiced. */
  narrationSeconds: number | null
  /** Footage spans the director marked to drop (original-video seconds). The
   *  master director's first pass — never overwritten; refined edits live in
   *  `refined.cuts`. */
  cuts?: Cut[]
  /** The master director's coarse voicing plan for this chapter (story 03j):
   *  'original' = ship this span in the creator's own audio, trims as cuts;
   *  'revoice' = tightened narration to be re-voiced (the pre-03j behavior);
   *  'mixed' = some of both — the refiner decides where. Absent = unknown
   *  (old persisted projects / old responses) — no badge. */
  voicing?: 'original' | 'revoice' | 'mixed'
  /** Per-scene dense contact sheets captured for the refiner (story 03c,
   *  button 1). Like the prep sheets, only the bucket `url` is persisted — the
   *  base64 `dataUrl` is dropped after upload. */
  sheets?: ContactSheet[]
  /** Second-pass refiner output (story 03c). Absent/null = fall back to the
   *  baseline (the scene `transcript` + the director's `cuts`). */
  refined?: SceneRefinement | null
  /** Creator's per-scene instruction for the refiner (story 03l). An INPUT, not
   *  refiner output — it survives revert (`refined = null`) and seeds the next
   *  re-refine. Sent as the refine request's `direction`. */
  refinePrompt?: string
  /** Include the global director prompt as context in this scene's refine calls
   *  (story 03l). ABSENT = true (the checkbox defaults checked); explicit
   *  `false` excludes it. Input-layer, like `refinePrompt` — survives revert. */
  includeDirection?: boolean
  /** Job id of the refine run that produced `refined` (story 03m) — lets the
   *  prompt disclosure lazy-fetch what was sent to Gemini. Cleared on revert
   *  (the prompt belongs to the refinement just discarded). */
  promptJobId?: string
  /** Serve path of this scene's own sliced clip — `[start, end]` of the source,
   *  cut frame-accurately and uploaded on its own (story 03g, the "Cut this
   *  scene" build step). Absent until that step runs. Once set, the Build preview
   *  plays this small clip instead of the whole source, and the per-scene assemble
   *  reads it. Re-cutting overwrites it. */
  clipUrl?: string
  /** Serve path of this scene's soundtrack — the same `[start, end]` span sliced
   *  from the talk WAV and uploaded at cut time alongside `clipUrl` (story 03k).
   *  URL-only, like everything persisted. The refiner requires it (Gemini listens
   *  to align cuts/segments to the natural flow). Re-cutting overwrites it. */
  clipAudioUrl?: string
  /** Serve path of this scene's **assembled** cut — its clip with cuts dropped and
   *  narration laid over it, rendered + saved one scene at a time (story 03g phase
   *  2). Absent until you assemble & save this scene. The final master cut is the
   *  stream-copy concat of every scene's `assembledUrl`. Re-assembling overwrites it. */
  assembledUrl?: string
  /** In-flight `/api/refine-scene` job id (story 03f Part 0). Set while the async
   *  refine job is running so a hard reload resumes polling instead of stranding
   *  it; cleared (null) on terminal status. */
  refineJobId?: string | null
  thumb?: string
}

/** Speaking rate used to estimate narration length from text. */
export const WORDS_PER_SECOND = 2.5
/** How far narration vs video can differ and still count as aligned. */
export const ALIGN_TOLERANCE = 1.5

export function wordCount(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/** Estimated seconds to speak `text` in the cloned voice. */
export function narrationSeconds(text: string): number {
  return wordCount(text) / WORDS_PER_SECOND
}

export function sceneVideoSeconds(scene: Scene): number {
  return Math.max(0, scene.end - scene.start)
}

/**
 * Which scene owns a given original-video second. Scenes tile the timeline
 * contiguously, so `[start, end)` is half-open; the very last second falls into
 * the final scene (its `end` is inclusive). Used to route a click on the
 * whole-talk diff grid to the right scene's cut layer. Null if `t` is before
 * the first scene or there are no scenes.
 */
export function sceneAtTime(scenes: Scene[], t: number): Scene | null {
  for (const s of scenes) if (t >= s.start && t < s.end) return s
  const last = scenes[scenes.length - 1]
  return last && t >= last.start && t <= last.end ? last : null
}

export type Alignment = { deltaSeconds: number; status: 'short' | 'long' | 'aligned' }

/** Compare voiced narration length to the scene's video length. */
export function alignment(scene: Scene): Alignment | null {
  if (scene.narrationSeconds == null) return null
  const delta = scene.narrationSeconds - sceneVideoSeconds(scene)
  const status =
    Math.abs(delta) <= ALIGN_TOLERANCE ? 'aligned' : delta < 0 ? 'short' : 'long'
  return { deltaSeconds: delta, status }
}

const FILLER =
  'so the idea here is pretty simple let me walk you through it step by step and show you exactly how it works in practice today'.split(
    ' ',
  )

/** Deterministic placeholder transcript of roughly `words` words. */
function fillerText(words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(FILLER[i % FILLER.length])
  if (out.length) out[0] = out[0][0].toUpperCase() + out[0].slice(1)
  return out.join(' ') + '.'
}

/**
 * Mock of the slice + direct steps: break `duration` into a few logical
 * 2–5 min scenes (≈3.5 min target), never fewer than one. Each scene maps to an
 * original-video span (`start`–`end`), carries the full span `transcript`, and a
 * default `refinePrompt` — the director's per-scene instruction to the refiner
 * (story 03q; the director no longer drafts a script).
 */
export function buildScenes(duration: number, targetSceneSeconds = 210, sourceId = 'source-1'): Scene[] {
  if (!Number.isFinite(duration) || duration <= 0) return []
  const count = Math.max(1, Math.round(duration / targetSceneSeconds))
  const each = duration / count

  return Array.from({ length: count }, (_, i) => {
    const start = i * each
    const end = i === count - 1 ? duration : (i + 1) * each
    const spanWords = Math.round((end - start) * WORDS_PER_SECOND)
    const transcript = fillerText(spanWords)
    const firstWords = transcript.split(' ').slice(0, 4).join(' ')
    return {
      id: `scene-${i + 1}`,
      index: i,
      sourceId,
      title: `Scene ${i + 1} — ${firstWords}…`,
      start,
      end,
      transcript,
      status: 'pending' as const,
      narrationSeconds: null,
      refinePrompt: `Tighten scene ${i + 1} to a crisp run; drop the dead air in the middle.`,
    }
  })
}
