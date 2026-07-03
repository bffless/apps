/**
 * The master director — the brain of the prep pipeline (story 03).
 *
 * One multimodal AI call (Gemini 3.1 Pro on Replicate) is handed three things:
 *
 *   1. the timestamped transcript (story 02),
 *   2. the director contact sheets — interval-sampled frames with the wall-clock
 *      burned on each (story 03 prep stage), as image input, and
 *   3. optional free-text *direction* the user types ("make it punchy", "keep the
 *      demo at 12:30", …).
 *
 * It returns, as strict JSON, a one-line **synopsis** of the whole talk plus the
 * **scenes** (story 13f contract, ADR-0003): each `{ title, start, end, brief,
 * cuts[] }` — a titled window of the recording, its **cutting brief** (the
 * director's prose instructions to the scene refiner), and the coarse baseline
 * footage spans to drop. Scenes **tile** the recording: windows touch
 * end-to-end, so footage can only be dropped by a cut, never by scene omission.
 * There is no script — the final cut is the original recording minus cuts.
 *
 * This module is the *pure* half — request shaping + response coercion — so it's
 * unit-tested and shared by the MSW mock and the real `/api/scenes` pipeline (the
 * pipeline does the same clamping server-side; this is the client-side mirror).
 * The authoritative prompt/system-instruction live in the BFFless pipeline.
 */

import { clockLabel } from './contactSheet'
import { sourceOffsets, type SourceLike } from './sources'
import type { Scene, Cut } from './scenes'
import type { TWord } from './transcriptGrid'

/** What the director returns per scene, before we coerce it to a `Scene`. */
export type DirectorScene = {
  title?: string
  /** Original-video span this scene maps to, in seconds. */
  start: number
  end: number
  /** Footage spans to drop, in original-video seconds, inside this scene. */
  cuts?: Cut[]
  /** The director's cutting brief for this scene (story 13f): prose
   *  instructions to the per-scene refiner — what to drop and why. */
  brief?: string
  /** Legacy wire fields (pre-13f pipeline), tolerated by `toScenes`: the span's
   *  echoed words, and the old name for the brief. */
  transcript?: string
  refinePrompt?: string
}

/** The director's full response: a logline plus the scene breakdown. */
export type DirectorResult = { synopsis: string; scenes: DirectorScene[] }

/** The request body the front end POSTs to `/api/scenes`. */
export type DirectorRequest = {
  /** Timestamped transcript text (see `timedTranscript`). */
  transcript: string
  /** Bucket serve paths of the contact sheets, in order. */
  sheetUrls: string[]
  /** Optional free-text direction from the user. */
  direction: string
  /** Source clip duration, so the model (and clamps) know the bounds. */
  duration: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Collapse a word-level transcript into compact timestamped lines for the
 * director's prompt — `[m:ss] words spoken in that window`, one line per
 * `secondsPerLine`-second window. Plain wall-clock (matching the contact-sheet
 * labels) so the model can line a moment it reads up with a frame it sees and
 * report back an original-video timestamp. Words without a timestamp ride along
 * with the current window.
 */
export function timedTranscript(words: TWord[], secondsPerLine = 8): string {
  if (!words.length || secondsPerLine <= 0) return ''
  const lines: { bucket: number; words: string[] }[] = []
  let current = -1
  for (const w of words) {
    const text = str(w?.text).trim()
    if (!text) continue
    const start = typeof w?.start === 'number' && Number.isFinite(w.start) ? w.start : null
    const bucket = start == null ? Math.max(0, current) : Math.floor(start / secondsPerLine)
    if (bucket !== current || lines.length === 0) {
      // New window — but keep null-timestamp words on the line we're already on.
      if (start != null || lines.length === 0) {
        lines.push({ bucket, words: [] })
        current = bucket
      }
    }
    lines[lines.length - 1].words.push(text)
  }
  return lines
    .map((l) => `[${clockLabel(l.bucket * secondsPerLine)}] ${l.words.join(' ')}`)
    .join('\n')
}

/** First few words of a script, for a fallback scene title. */
function leadWords(text: string, n = 5): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, n)
  return words.join(' ')
}

/** Clamp a cut span to `[lo, hi]`, returning null if it collapses to nothing. */
function clampCut(cut: Cut, lo: number, hi: number): Cut | null {
  const start = Math.min(Math.max(num(cut?.start), lo), hi)
  const end = Math.min(Math.max(num(cut?.end), lo), hi)
  if (end - start <= 0.05) return null
  return { start, end }
}

/** A source as `toScenes` needs it: id + duration, plus (optionally) its timed
 *  words so a scene's `transcript` can be derived locally — the 13f wire
 *  contract no longer echoes the words back. */
export type DirectorSource = SourceLike & { words?: TWord[] }

/**
 * Coerce the director's raw scenes into the app's `Scene[]`, mapping from the
 * **global** (concatenated) timeline the director reasons over back to
 * **per-source local** coordinates. Each returned scene carries a `sourceId`
 * and local `start`/`end` within that source.
 *
 * Scenes **tile** the recording (story 13f, ADR-0003): on the global timeline
 * the first scene starts at 0, each next scene starts exactly where the
 * previous ended (gaps the model leaves are snapped shut), and the last ends at
 * the total duration — footage can only be dropped by a cut, never by falling
 * between scene windows. The same rule is re-applied per source after
 * assignment, so every second of every source belongs to exactly one scene.
 *
 * A chapter belongs to exactly ONE video, so each scene is assigned to the single
 * source it **overlaps most**, then clamped to that source's local `[start, end)`
 * window (its cuts re-expressed in local coordinates). We deliberately do NOT
 * split a scene into one fragment per source it touches: the director's spans are
 * rounded (e.g. `0–23`), so they routinely overflow the real fractional source
 * durations by a fraction of a second, and splitting turned every such overflow
 * into a duplicate-titled sliver scene. Dominant-source assignment is robust to
 * that — one director scene maps to exactly one stored scene.
 *
 * A scene with no real overlap (≤ 0.05 s) against any source is dropped.
 * Single-source projects behave identically to the old signature: local time
 * equals global time and every scene gets `sourceId = sources[0].id`.
 *
 * Tolerant of both wire shapes: the 13f `brief` and the legacy `refinePrompt`
 * both land in `scene.brief`; a legacy echoed `transcript` is kept, otherwise
 * the transcript is derived from the source's own words in the scene window.
 */
export function toScenes(raw: DirectorScene[], sources: DirectorSource[]): Scene[] {
  if (!Array.isArray(raw) || sources.length === 0) return []
  const spans = sourceOffsets(sources)
  const bound = spans[spans.length - 1].end
  const sorted = [...raw].sort((a, b) => num(a?.start) - num(b?.start))

  // 1) TILE the GLOBAL timeline: each scene opens where the previous closed
  // (raw starts only decide the order), ends are clamped, the last runs to the
  // total duration.
  const global: { start: number; end: number; raw: DirectorScene }[] = []
  let cursor = 0
  for (const s of sorted) {
    const start = cursor
    let end = Math.min(Math.max(num(s?.end), start), bound)
    if (end <= start) end = Math.min(start + 0.05, bound)
    cursor = end
    global.push({ start, end, raw: s })
  }
  if (global.length) global[global.length - 1].end = bound

  // 2) assign each global scene to the source it overlaps most; convert to local
  const assigned: {
    span: { id: string; start: number; end: number }
    start: number
    end: number
    raw: DirectorScene
  }[] = []
  for (const g of global) {
    let best: { id: string; start: number; end: number } | null = null
    let bestOverlap = 0
    for (const span of spans) {
      const overlap = Math.min(g.end, span.end) - Math.max(g.start, span.start)
      if (overlap > bestOverlap) {
        bestOverlap = overlap
        best = span
      }
    }
    if (!best || bestOverlap <= 0.05) continue
    assigned.push({
      span: best,
      start: Math.max(g.start, best.start) - best.start,
      end: Math.min(g.end, best.end) - best.start,
      raw: g.raw,
    })
  }

  // 3) re-tile each source's local timeline: dominant-source assignment can
  // orphan a source's head/tail (a boundary-crossing scene keeps only its
  // dominant side), so snap the first scene to 0, each next to the previous
  // end, and the last to the source's duration. Only ever widens a window, so
  // the cuts clamped below stay inside it.
  const lastBySource = new Map<string, number>()
  for (let i = assigned.length - 1; i >= 0; i--) {
    if (!lastBySource.has(assigned[i].span.id)) lastBySource.set(assigned[i].span.id, i)
  }
  const cursorBySource = new Map<string, number>()
  for (let i = 0; i < assigned.length; i++) {
    const a = assigned[i]
    a.start = cursorBySource.get(a.span.id) ?? 0
    if (lastBySource.get(a.span.id) === i) a.end = a.span.end - a.span.start
    if (a.end < a.start) a.end = a.start
    cursorBySource.set(a.span.id, a.end)
  }

  // 4) build the Scene objects off the final windows
  const out: Scene[] = []
  for (const a of assigned) {
    const i = out.length
    const source = sources.find((s) => s.id === a.span.id)
    const transcript =
      str(a.raw?.transcript).trim() ||
      (source?.words ?? [])
        .filter((w) => typeof w?.start === 'number' && w.start >= a.start && w.start < a.end)
        .map((w) => str(w?.text).trim())
        .filter(Boolean)
        .join(' ')
    const brief = str(a.raw?.brief).trim() || str(a.raw?.refinePrompt).trim()
    const title = str(a.raw?.title).trim() || (leadWords(transcript) ? `${leadWords(transcript)}…` : `Scene ${i + 1}`)
    const cuts = (Array.isArray(a.raw?.cuts) ? a.raw.cuts : [])
      .map((c) => clampCut({ start: num(c?.start) - a.span.start, end: num(c?.end) - a.span.start }, a.start, a.end))
      .filter((c): c is Cut => c !== null)
    out.push({
      id: `scene-${i + 1}`, index: i, sourceId: a.span.id, title,
      start: a.start, end: a.end, transcript, status: 'pending', cuts,
      ...(brief ? { brief } : {}),
    })
  }
  return out
}

/** One source's transcript for the combined director request (story 09c). */
export type TranscriptSource = { id: string; fileName: string; duration: number; words: TWord[] }

/** Resolve a `(videoId, speakerLabel)` to a display name for the director prompt. */
export type SpeakerNamer = (videoId: string, speakerLabel: string) => string

/**
 * Like `timedTranscript`, but when words carry a `speaker`, group consecutive
 * same-speaker runs and prefix each emitted line with `Name:` (story 10c). A run
 * is broken by either a speaker change or the time window rolling over, so the
 * `[m:ss]` anchors are preserved. Single-speaker input yields the same name on
 * every line (cheap, and the director ignores it) — effectively today's output
 * plus a name.
 */
export function speakerTimedTranscript(
  words: TWord[],
  name: (label: string) => string,
  secondsPerLine = 8,
): string {
  if (!words.length || secondsPerLine <= 0) return ''
  const lines: { bucket: number; speaker: string | undefined; words: string[] }[] = []
  let curBucket = -1
  let curSpeaker: string | undefined
  for (const w of words) {
    const text = str(w?.text).trim()
    if (!text) continue
    const start = typeof w?.start === 'number' && Number.isFinite(w.start) ? w.start : null
    const bucket = start == null ? Math.max(0, curBucket) : Math.floor(start / secondsPerLine)
    const speaker = w?.speaker
    const rollover = start != null && (bucket !== curBucket || speaker !== curSpeaker)
    if (rollover || lines.length === 0) {
      lines.push({ bucket, speaker, words: [] })
      curBucket = bucket
      curSpeaker = speaker
    }
    lines[lines.length - 1].words.push(text)
  }
  return lines
    .map((l) => {
      const who = l.speaker ? `${name(l.speaker)}: ` : ''
      return `[${clockLabel(l.bucket * secondsPerLine)}] ${who}${l.words.join(' ')}`
    })
    .join('\n')
}

/**
 * Build ONE timestamped transcript across all source videos for the master
 * director (story 09c): each source's words are offset onto the global timeline
 * (video A at [0,durA), B at [durA, ...], ...) via `sourceOffsets`, run through the
 * existing `timedTranscript`, and joined with a labeled boundary marker naming
 * the next video and its global start -- so the director sees one continuous talk
 * but knows where each video begins (and must not start a chapter in one video
 * and end it in another; if one does, `toScenes` assigns it to the source it
 * overlaps most rather than splitting it).
 *
 * When an optional `namer` is provided (story 10c), words with a `speaker` field
 * are grouped by consecutive speaker runs and prefixed with the resolved display
 * name. Without a namer, output is byte-identical to today's behaviour.
 */
export function combinedTimedTranscript(sources: TranscriptSource[], namer?: SpeakerNamer): string {
  const spans = sourceOffsets(sources)
  return sources
    .map((s, i) => {
      const offset = spans[i].start
      const shifted: TWord[] = s.words.map((w) => ({
        ...w,
        start: typeof w.start === 'number' ? w.start + offset : w.start,
        end: typeof w.end === 'number' ? w.end + offset : w.end,
      }))
      const body = namer
        ? speakerTimedTranscript(shifted, (label) => namer(s.id, label))
        : timedTranscript(shifted)
      const header = `--- VIDEO ${i + 1}: ${s.fileName} (starts ${clockLabel(offset)}) ---`
      return i === 0 ? `${header}\n${body}` : `\n${header}\n${body}`
    })
    .join('\n')
}
