/**
 * The per-scene refiner — the second pass (story 03c, reshaped by ADR-0003).
 *
 * The master director (story 03) sees the whole talk and returns a per-scene
 * `refinePrompt` (its cutting brief) + coarse `cuts`. The refiner zooms into ONE
 * scene: it spends the whole image budget on that scene (a much denser contact
 * sheet), listens to the scene's soundtrack, and hands back **precise cuts** —
 * nothing else. There is no script: the final cut is the original recording
 * minus cuts (see `docs/adr/0003-cut-first-editing.md`), so the refiner's whole
 * job is deciding which spans of footage die.
 *
 * Like `director.ts`, this is the *pure* half: request shaping + response
 * coercion, shared by the MSW mock and the real `/api/refine-scene` pipeline (the
 * pipeline clamps server-side too; this mirrors it client-side). The
 * authoritative prompt/system-instruction live in the BFFless pipeline. The 13f
 * request carries the scene's timed words, its dense contact sheets, the
 * director's cutting `brief`, and the **measured dead space** (story 13c) so the
 * model can snap cut edges into true silence, never mid-word; the response is
 * `cuts[]` only. Legacy `segments` from an un-updated pipeline are ignored.
 *
 * **Non-destructive:** `toRefinement` produces a `SceneRefinement` that lives in
 * `scene.refined` — it never touches the director's baseline `cuts`, so the
 * producer can always revert by clearing `refined`.
 */

import type { Cut, Scene, SceneRefinement } from './scenes'
import type { DeadSpan } from './deadSpace'
import type { TWord } from './transcriptGrid'

/** The refiner's raw response: precise cuts, plus whether the model actually
 *  heard the scene (`false` = the pipeline's deaf re-run placed these cuts).
 *  Legacy fields (`segments`) from a pre-13f pipeline may still appear —
 *  ignored, as is a missing `heardAudio` from a pipeline predating it. */
export type RefineSceneRaw = { cuts?: Cut[]; heardAudio?: boolean }

/** The request body the front end POSTs to `/api/refine-scene`. */
export type RefineSceneRequest = {
  /** The scene's original-video span — the bounds the model works within. */
  start: number
  end: number
  /** Per-word timing for just this scene's words (see `sceneWordTimings`) — the
   *  exact boundaries the refiner rebuilds the cut from (story 03p). */
  wordTimings: string
  /** Bucket serve paths of the scene's dense contact sheets, in order. */
  sheetUrls: string[]
  /** Serve path of the scene's cut soundtrack (`scene.clipAudioUrl`) — required;
   *  the pipeline signs it like the sheets and Gemini listens to align cut
   *  boundaries to the natural flow of speech (story 03k). */
  audioUrl: string
  /** The director's cutting brief for this scene (`scene.brief`, trimmed) —
   *  story 13f: promoted from the old seeded refinePrompt to its own contract
   *  field, so it always rides the request untouched by creator edits. */
  brief: string
  /** The scene's measured dead space (story 13c) as `start end` lines — the
   *  same format as `wordTimings`, built by `deadSpaceLines(sceneDeadSpace(…))`.
   *  True silence measured from the WAV: the prime territory for cut edges. */
  deadSpace: string
  /** The creator's per-scene instruction (`scene.refinePrompt`, trimmed). */
  direction: string
  /** The creator's global director prompt, forwarded as whole-video context
   *  while the scene's include-checkbox is on (story 03l); `''` when the
   *  checkbox is off or the prompt is empty. */
  directorDirection: string
  /** This scene's 1-based position and the total scene count, so the refiner can
   *  place the scene in the arc ("scene 3 of 7") — story 03r. */
  sceneNumber: number
  sceneCount: number
  /** The tail of the PREVIOUS scene's kept speech — the lead-in this scene opens
   *  from, so cut decisions at the seam account for the neighbor (story 03r).
   *  `''` for the first scene. Machine context, not creator intent. */
  previousContext: string
}

/**
 * The two creator-prompt fields of a refine request (story 03l): the scene's own
 * `refinePrompt`, plus the global director prompt — forwarded only while the
 * scene's include-checkbox is on (absent = on). Both trimmed and never
 * undefined, so the wire shape stays stable for mock and real alike.
 */
export function refineDirections(
  scene: Pick<Scene, 'refinePrompt' | 'includeDirection'>,
  direction: string,
): { direction: string; directorDirection: string } {
  return {
    direction: (scene.refinePrompt ?? '').trim(),
    directorDirection: scene.includeDirection === false ? '' : direction.trim(),
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Per-word timing for the scene's words, in seconds on the shared (whole-talk)
 * timeline. The refiner reads this to place cuts FROM SCRATCH (story 03p): pick
 * which words survive and copy their precise start/end, instead of eyeballing a
 * time inside an 8-second line. One `start end word` triple per line, fixed to
 * 2 decimals (WhisperX resolution). Words missing a finite start are skipped.
 */
export function sceneWordTimings(words: TWord[]): string {
  return words
    .map((w) => {
      const text = str(w?.text).trim()
      const start = w?.start
      if (!text || typeof start !== 'number' || !Number.isFinite(start)) return null
      const end = typeof w?.end === 'number' && Number.isFinite(w.end) ? w.end : start
      return `${start.toFixed(2)} ${end.toFixed(2)} ${text}`
    })
    .filter((l): l is string => l !== null)
    .join('\n')
}

/**
 * The measured dead-space spans that concern ONE scene (story 13f): each span
 * clamped to the scene's `[start, end]` window, spans that collapse to nothing
 * dropped. Same shared-timeline seconds as the word timings and the cuts.
 */
export function sceneDeadSpace(spans: DeadSpan[], scene: Pick<Scene, 'start' | 'end'>): DeadSpan[] {
  return (Array.isArray(spans) ? spans : [])
    .map((s) => clampSpan(num(s?.start), num(s?.end), scene.start, scene.end))
    .filter((s): s is DeadSpan => s !== null)
}

/**
 * Dead-space spans as prompt lines — one `start end` pair per line, fixed to
 * 2 decimals, mirroring `sceneWordTimings` so the model reads both lists in the
 * same notation. `''` when the scene has no measured silence.
 */
export function deadSpaceLines(spans: DeadSpan[]): string {
  return spans.map((s) => `${s.start.toFixed(2)} ${s.end.toFixed(2)}`).join('\n')
}

/** Clamp a cut span to `[lo, hi]`, returning null if it collapses to nothing. */
function clampSpan(start: number, end: number, lo: number, hi: number): { start: number; end: number } | null {
  const s = Math.min(Math.max(start, lo), hi)
  const e = Math.min(Math.max(end, lo), hi)
  if (e - s <= 0.05) return null
  return { start: s, end: e }
}

/**
 * Coerce the refiner's raw response into a `SceneRefinement`, clamped to the
 * scene: every cut snapped into `[scene.start, scene.end]`, empty/zero-length
 * spans dropped, the set normalized (sorted, merged). The server validates too;
 * this guarantees the UI never sees a cut outside the scene even if the model
 * slips. `source` is always `'ai'` here — hand-edits set `'manual'`.
 */
export function toRefinement(raw: RefineSceneRaw, scene: Scene): SceneRefinement {
  const cuts: Cut[] = (Array.isArray(raw?.cuts) ? raw.cuts : [])
    .map((c) => clampSpan(num(c?.start), num(c?.end), scene.start, scene.end))
    .filter((c): c is Cut => c !== null)
  return {
    cuts: normalizeCuts(cuts),
    source: 'ai',
    // Only carried when the pipeline explicitly says the refiner went deaf, so
    // an older pipeline (no `heardAudio`) never claims a problem it can't know
    // about.
    ...(raw?.heardAudio === false ? { heardAudio: false } : {}),
  }
}

/**
 * Merge a cut list into a clean, sorted, non-overlapping set: drop sub-cell
 * slivers, sort by start, and coalesce spans that touch or overlap (within the
 * 0.05s float tolerance). Both hand-edit primitives below funnel through this so
 * the stored `refined.cuts` is always tidy — e.g. adding the dead air between two
 * adjacent cuts collapses all three into one.
 */
export function normalizeCuts(cuts: Cut[]): Cut[] {
  const sorted = [...cuts]
    .filter((c) => c.end - c.start > 0.05)
    .sort((a, b) => a.start - b.start)
  const out: Cut[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start <= last.end + 0.05) last.end = Math.max(last.end, c.end)
    else out.push({ start: c.start, end: c.end })
  }
  return out
}

/**
 * Hand-edit: add a cut span (clamped to the scene), merging it into any cut it
 * touches. Covers both **add a new cut** (span over kept footage) and **extend a
 * cut** (span adjacent to an existing one — the merge grows it).
 */
export function addCut(cuts: Cut[], span: Cut, scene: Pick<Scene, 'start' | 'end'>): Cut[] {
  const clamped = clampSpan(span.start, span.end, scene.start, scene.end)
  if (!clamped) return normalizeCuts(cuts)
  return normalizeCuts([...cuts, clamped])
}

/**
 * The batch form of `addCut` (story 13e auto-trim): merge a whole set of spans
 * into the cuts in ONE pass — each clamped to the scene like any hand edit,
 * the result normalized once. The tool writes all its cuts through a single
 * state patch; feeding them one-by-one through `addCut` state writes would
 * base each on a stale snapshot and keep only the last.
 */
export function addCuts(cuts: Cut[], spans: Cut[], scene: Pick<Scene, 'start' | 'end'>): Cut[] {
  const clamped = spans
    .map((s) => clampSpan(s.start, s.end, scene.start, scene.end))
    .filter((c): c is Cut => c !== null)
  return normalizeCuts([...cuts, ...clamped])
}

/**
 * Hand-edit: remove a span from the cut set — **contract a cut** from its edge,
 * or carve out the middle (which splits one cut into two). Spans the removal
 * doesn't touch pass through untouched.
 */
export function removeCut(cuts: Cut[], span: Cut): Cut[] {
  const out: Cut[] = []
  for (const c of cuts) {
    if (span.end <= c.start || span.start >= c.end) {
      out.push(c) // no overlap — keep whole
      continue
    }
    if (c.start < span.start) out.push({ start: c.start, end: span.start }) // left remainder
    if (c.end > span.end) out.push({ start: span.end, end: c.end }) // right remainder
    // fully covered → dropped
  }
  return normalizeCuts(out)
}

/** The cuts to apply for a scene: the refiner's if refined, else the director's. */
export function effectiveCuts(scene: Scene): Cut[] {
  return scene.refined ? scene.refined.cuts : (scene.cuts ?? [])
}

/**
 * The complement of `cuts` within `[start, end]` — the footage that survives, in
 * order. This is what a scene's stitched preview plays and what export
 * concatenates. Cuts are normalized first; sub-0.05s kept slivers are dropped so
 * a hairline gap between two cuts doesn't become a one-frame flash.
 */
export function keptSpans(cuts: Cut[], start: number, end: number): Cut[] {
  const out: Cut[] = []
  let cursor = start
  for (const c of normalizeCuts(cuts)) {
    const s = Math.max(start, Math.min(c.start, end))
    const e = Math.max(start, Math.min(c.end, end))
    if (s - cursor > 0.05) out.push({ start: cursor, end: s })
    cursor = Math.max(cursor, e)
  }
  if (end - cursor > 0.05) out.push({ start: cursor, end })
  return out
}

/**
 * The words that survive a scene's cuts — a word lives if its midpoint is
 * outside every cut. This is the scene's "kept speech": the script the viewer
 * actually hears (blog/describe read it), and the source of `sceneTail`.
 */
export function keptWords(words: TWord[], cuts: Cut[]): TWord[] {
  const normalized = normalizeCuts(cuts)
  return words.filter((w) => {
    const mid = (w.start + (typeof w.end === 'number' ? w.end : w.start)) / 2
    return !normalized.some((c) => mid >= c.start && mid < c.end)
  })
}

/**
 * The tail of a scene's kept speech — the last `maxWords` words the viewer hears
 * after the scene's effective cuts. Fed to the refiner as the PREVIOUS scene's
 * lead-in context (story 03r) so cut decisions at the seam aren't made blind to
 * the neighbor. Falls back to the raw scene transcript when the caller has no
 * word timings for the scene. Returns `''` for an empty scene.
 */
export function sceneTail(scene: Scene, words: TWord[] = [], maxWords = 30): string {
  const kept = words.length
    ? keptWords(words, effectiveCuts(scene)).map((w) => str(w.text).trim())
    : str(scene.transcript).trim().split(/\s+/)
  const flat = kept.filter(Boolean)
  return flat.slice(Math.max(0, flat.length - maxWords)).join(' ')
}
