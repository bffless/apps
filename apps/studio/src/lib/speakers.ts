/**
 * Pure resolution between diarization speaker labels and the project cast
 * (story 10b). Labels are per-video (WhisperX diarizes each file on its own), so
 * everything here is keyed by `(videoId, speakerLabel)`. Shared by the cast UI,
 * the director transcript shaping (10c), and per-segment voicing (10d).
 */
import type { TWord } from './transcriptGrid'
import type { Person, VoiceChoice } from '../store/studioSlice'

export type SpeakerAssignments = Record<string, Record<string, string>>

/** Distinct speaker labels in `words`, in first-seen order; undefined dropped. */
export function uniqueSpeakers(words: TWord[]): string[] {
  const seen: string[] = []
  for (const w of words) {
    const s = w.speaker
    if (s && !seen.includes(s)) seen.push(s)
  }
  return seen
}

/**
 * The cast person a `(videoId, label)` resolves to: an explicit assignment wins;
 * otherwise a single-person cast is the implicit answer (the common "just me"
 * case needs no per-video work); otherwise null (ambiguous + unassigned).
 */
export function resolvePerson(
  videoId: string,
  label: string,
  cast: Person[],
  assignments: SpeakerAssignments,
): Person | null {
  const id = assignments[videoId]?.[label]
  if (id) return cast.find((p) => p.id === id) ?? null
  if (cast.length === 1) return cast[0]
  return null
}

/**
 * Like `resolvePerson` but WITHOUT the single-person implicit fallback: only an
 * explicit assignment resolves to a person. The prep transcript preview uses
 * this so an un-mapped speaker reads as its RAW label (`SPEAKER_01`) instead of
 * collapsing onto the lone default person ("Me") before the producer has
 * actually mapped speakers to people (story 10b/10c).
 */
export function resolveAssignedPerson(
  videoId: string,
  label: string,
  cast: Person[],
  assignments: SpeakerAssignments,
): Person | null {
  const id = assignments[videoId]?.[label]
  return id ? (cast.find((p) => p.id === id) ?? null) : null
}

/** Voice for a `(videoId, label)`, via `resolvePerson`. Null if unresolved/unvoiced. */
export function resolveSpeakerVoice(
  videoId: string,
  label: string,
  cast: Person[],
  assignments: SpeakerAssignments,
): VoiceChoice | null {
  return resolvePerson(videoId, label, cast, assignments)?.voice ?? null
}

/**
 * Pre-seed a video's assignments by ordinal: the Nth detected label → the Nth
 * cast person. Existing assignments for the video are preserved (only fills gaps).
 */
export function seedAssignmentsByLabel(
  videoId: string,
  labels: string[],
  cast: Person[],
  assignments: SpeakerAssignments,
): Record<string, string> {
  const out = { ...(assignments[videoId] ?? {}) }
  labels.forEach((label, i) => {
    if (!out[label] && cast[i]) out[label] = cast[i].id
  })
  return out
}

/**
 * The dominant speaker over a local time window `[start, end)` of a source's
 * words — the label whose words cover the most time in the window (story 10d).
 * Null if no word overlaps. Ties break to the first-seen label.
 */
export function dominantSpeaker(words: TWord[], start: number, end: number): string | null {
  const totals = new Map<string, number>()
  for (const w of words) {
    if (!w.speaker) continue
    const o = Math.min(end, w.end) - Math.max(start, w.start)
    if (o > 0) totals.set(w.speaker, (totals.get(w.speaker) ?? 0) + o)
  }
  let best: string | null = null
  let bestO = 0
  for (const [label, o] of totals) if (o > bestO) { bestO = o; best = label }
  return best
}

/** An audio span, in seconds. */
export type SampleSpan = { start: number; end: number }

/**
 * A few representative audio spans for a speaker, so the producer can HEAR who
 * `SPEAKER_xx` is before mapping them to a person (story 10b). Walks the speaker's
 * contiguous runs (consecutive words tagged with `label`), caps each to
 * `maxSeconds`, prefers runs at least `minSeconds` long, and returns up to
 * `maxSamples` of them in chronological order. Empty if the speaker never speaks.
 */
export function speakerSampleSpans(
  words: TWord[],
  label: string,
  opts: { maxSamples?: number; maxSeconds?: number; minSeconds?: number } = {},
): SampleSpan[] {
  const maxSamples = opts.maxSamples ?? 2
  const maxSeconds = opts.maxSeconds ?? 6
  const minSeconds = opts.minSeconds ?? 1.2

  // Contiguous runs of this speaker's words (a different speaker's word ends a run).
  const runs: SampleSpan[] = []
  let cur: SampleSpan | null = null
  for (const w of words) {
    const ok = w.speaker === label && Number.isFinite(w.start) && Number.isFinite(w.end)
    if (ok) {
      if (cur) cur.end = Math.max(cur.end, w.end)
      else cur = { start: w.start, end: w.end }
    } else if (cur) {
      runs.push(cur)
      cur = null
    }
  }
  if (cur) runs.push(cur)
  if (!runs.length) return []

  // Cap each run's length; prefer the long-enough ones, else fall back to all.
  const capped = runs.map((r) => ({ start: r.start, end: Math.min(r.end, r.start + maxSeconds) }))
  const long = capped.filter((r) => r.end - r.start >= minSeconds)
  const pool = long.length ? long : capped

  // Longest first → take a couple → present in chronological order.
  return [...pool]
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, maxSamples)
    .sort((a, b) => a.start - b.start)
}
