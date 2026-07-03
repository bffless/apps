/**
 * Measured dead space (ADR-0003, story 13c): spans of the source audio with no
 * meaningful sound, measured from the extracted 16 kHz WAV itself — RMS energy
 * per grid slice against a silence threshold — never inferred from gaps between
 * transcript word timestamps. True silence is the prime territory for a cut;
 * energy without words ("noise": breaths, clicks, chair squeaks) may not cut
 * cleanly, so the grid renders the two distinctly.
 *
 * Pure + deterministic over decoded PCM; the WebAudio decode lives in
 * `audio.ts` (`extractAudio` / `deadSpaceFromUrl`), which feeds this the same
 * mono samples the WAV is encoded from.
 */

/** A span of measured silence, in original-video seconds. */
export type DeadSpan = { start: number; end: number }

/** Measurement slice — matches the cut grid's finest cell (0.1 s). */
export const DEAD_SLICE_SECONDS = 0.1

/** RMS below this reads as silence (~ -40 dBFS — room tone on a voice take). */
export const DEFAULT_SILENCE_THRESHOLD = 0.01

/** Silences shorter than this aren't dead space — they're the natural pauses
 *  between words, not cut territory. */
export const DEFAULT_MIN_SILENCE_SECONDS = 0.3

export type DeadSpaceOptions = {
  threshold?: number
  minSilenceSeconds?: number
}

/** Persisted spans stay tidy: millisecond precision is plenty for a 0.1 s grid
 *  and avoids float-noise like 0.30000000000000004 in localStorage/sync JSON. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000

/**
 * RMS energy of each `sliceSeconds`-wide slice of mono PCM. The last slice may
 * be partial (fewer samples); its RMS is over what's actually there, so a quiet
 * tail still measures quiet rather than being padded down with zeros.
 */
export function rmsPerSlice(
  samples: Float32Array,
  sampleRate: number,
  sliceSeconds: number = DEAD_SLICE_SECONDS,
): number[] {
  const perSlice = Math.max(1, Math.round(sliceSeconds * sampleRate))
  const out: number[] = []
  for (let i = 0; i < samples.length; i += perSlice) {
    const end = Math.min(samples.length, i + perSlice)
    let sum = 0
    for (let j = i; j < end; j++) sum += samples[j] * samples[j]
    out.push(Math.sqrt(sum / (end - i)))
  }
  return out
}

/**
 * Merge consecutive below-threshold slices into silence spans, dropping any run
 * shorter than `minSilenceSeconds`. Span edges land on slice boundaries — the
 * same 0.1 s lattice the cut grid snaps to.
 */
export function deadSpaceSpans(
  rms: number[],
  sliceSeconds: number = DEAD_SLICE_SECONDS,
  { threshold = DEFAULT_SILENCE_THRESHOLD, minSilenceSeconds = DEFAULT_MIN_SILENCE_SECONDS }: DeadSpaceOptions = {},
): DeadSpan[] {
  const out: DeadSpan[] = []
  let runStart = -1
  // A half-slice epsilon keeps a run of exactly minSilence slices in, despite
  // float drift in `slices * sliceSeconds`.
  const minSlices = Math.ceil(minSilenceSeconds / sliceSeconds - 0.5)
  for (let i = 0; i <= rms.length; i++) {
    const silent = i < rms.length && rms[i] < threshold
    if (silent && runStart < 0) runStart = i
    if (!silent && runStart >= 0) {
      if (i - runStart >= minSlices) {
        out.push({ start: round3(runStart * sliceSeconds), end: round3(i * sliceSeconds) })
      }
      runStart = -1
    }
  }
  return out
}

/** Decode-once composition: PCM → per-slice RMS → silence spans, with the final
 *  span clamped to the audio's real length (the last slice is padded to the
 *  lattice otherwise). This is what the extract stage stores in the slice. */
export function measureDeadSpace(
  samples: Float32Array,
  sampleRate: number,
  opts: DeadSpaceOptions = {},
): DeadSpan[] {
  const spans = deadSpaceSpans(rmsPerSlice(samples, sampleRate), DEAD_SLICE_SECONDS, opts)
  const duration = samples.length / sampleRate
  return spans.map((s) => (s.end > duration ? { ...s, end: round3(duration) } : s))
}

/** Sort + merge overlapping/touching spans into a disjoint ascending list. */
function mergeSpans(spans: DeadSpan[]): DeadSpan[] {
  const sorted = spans
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
  const out: DeadSpan[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Ignore complement slivers under this — they're span-edge float dust, not a
 *  real stretch of unexplained sound. */
const NOISE_MIN_SECONDS = 0.01

/**
 * The grid's third state: everything on `[0, totalSeconds]` that is neither
 * spoken (inside a word's `[start, end]`) nor measured silence has energy but
 * no words — breaths, clicks, keyboard. Complement of the merged word + dead
 * spans, so the renderer can paint noise cells with the same span→columns
 * mapping it already uses for cuts.
 */
export function noiseSpans(
  words: DeadSpan[],
  dead: DeadSpan[],
  totalSeconds: number,
): DeadSpan[] {
  if (!(totalSeconds > 0)) return []
  const covered = mergeSpans([...words, ...dead])
  const out: DeadSpan[] = []
  let cursor = 0
  for (const s of covered) {
    if (s.start - cursor > NOISE_MIN_SECONDS) {
      out.push({ start: round3(cursor), end: round3(Math.min(s.start, totalSeconds)) })
    }
    cursor = Math.max(cursor, s.end)
    if (cursor >= totalSeconds) break
  }
  if (totalSeconds - cursor > NOISE_MIN_SECONDS) {
    out.push({ start: round3(cursor), end: round3(totalSeconds) })
  }
  return out
}
