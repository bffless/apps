/**
 * Auto-trim dead space (story 13e): a deterministic, client-side tool that
 * turns measured dead space into cuts — no AI. Given the silence-threshold /
 * minimum-pause / keep-padding knobs, it derives which spans of true silence
 * die and hands them to the editor as ONE batch of manual cuts (written through
 * `scene.refined`, `source: 'manual'`, like any drag — so revert still works).
 *
 * The span→cuts derivation here is pure arithmetic over dead-space spans. The
 * *threshold* knob operates a level up: at the measured default it reuses the
 * spans 13c stored in the slice; any other value re-derives spans from the
 * WAV's per-slice RMS (`deadSpaceSpans`) — the stored spans are binary, the
 * energy behind them is gone, so a threshold can't be re-applied to them.
 */

import type { Cut } from './scenes'
import { keptSpans } from './refiner'
import { DEFAULT_SILENCE_THRESHOLD, type DeadSpan } from './deadSpace'

export type AutoTrimKnobs = {
  /** RMS below this reads as silence. At `DEFAULT_SILENCE_THRESHOLD` the tool
   *  trims the slice's stored spans (exactly what the grid dims); any other
   *  value re-derives spans from the WAV. */
  threshold: number
  /** A silence must run at least this long (within the scene) to be trimmed —
   *  shorter pauses are the natural rhythm of speech, not cut territory. */
  minPauseSeconds: number
  /** Breathing room kept on EACH side of a trimmed pause, so the cut never
   *  clips the word it follows or jump-cuts into the next one. */
  keepPaddingSeconds: number
}

export const DEFAULT_AUTO_TRIM_KNOBS: AutoTrimKnobs = {
  threshold: DEFAULT_SILENCE_THRESHOLD,
  minPauseSeconds: 0.6,
  keepPaddingSeconds: 0.2,
}

/** Threshold choices, labelled in dBFS (the linear RMS is what the math uses;
 *  −40 dB is the 13c measurement default, so it needs no re-derive). */
export const THRESHOLD_OPTIONS = [
  { label: '−50 dB (strict)', value: 0.00316 },
  { label: '−45 dB', value: 0.00562 },
  { label: '−40 dB (default)', value: DEFAULT_SILENCE_THRESHOLD },
  { label: '−35 dB', value: 0.0178 },
  { label: '−30 dB (loose)', value: 0.0316 },
]

/** All ≥ the 0.3 s floor the stored spans were measured with, so every choice
 *  is answerable from the slice without re-deriving. */
export const MIN_PAUSE_OPTIONS = [0.3, 0.6, 1, 1.5]

export const PADDING_OPTIONS = [0, 0.1, 0.2, 0.3]

/** Below this a cut is a sliver, not an edit — the same tolerance
 *  `normalizeCuts` drops. */
const MIN_CUT_SECONDS = 0.05

/** Guards `>=` comparisons against float drift on the ms-rounded span lattice
 *  (e.g. a stored 0.6 s pause must satisfy a 0.6 s minimum). */
const EPSILON = 1e-6

/** Cut edges get persisted (refined.cuts → localStorage/sync JSON) — keep them
 *  ms-tidy, same as the dead-space spans they derive from. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000

/**
 * The core span→cuts derivation: each dead-space span, clamped to the scene
 * window, that still runs at least `minPauseSeconds` becomes a cut inset by
 * `keepPaddingSeconds` on each side. A pause the padding collapses (or a
 * boundary sliver) yields nothing. Clamp-then-measure is deliberate: a pause
 * straddling a scene edge only counts for what falls inside this scene — the
 * neighbouring scene trims its own share.
 */
export function autoTrimCuts(
  spans: DeadSpan[],
  window: { start: number; end: number },
  { minPauseSeconds, keepPaddingSeconds }: Pick<AutoTrimKnobs, 'minPauseSeconds' | 'keepPaddingSeconds'>,
): Cut[] {
  const out: Cut[] = []
  for (const span of spans) {
    const s = Math.max(span.start, window.start)
    const e = Math.min(span.end, window.end)
    if (e - s < minPauseSeconds - EPSILON) continue
    const cut = { start: round3(s + keepPaddingSeconds), end: round3(e - keepPaddingSeconds) }
    if (cut.end - cut.start > MIN_CUT_SECONDS) out.push(cut)
  }
  return out
}

/** Seconds of kept footage in `window` after `cuts` — the readout arithmetic,
 *  scoped to one scene. */
function keptSeconds(cuts: Cut[], window: { start: number; end: number }): number {
  return keptSpans(cuts, window.start, window.end).reduce((t, s) => t + (s.end - s.start), 0)
}

/** What one tool run would do: the cuts it will write and the seconds of
 *  footage they remove BEYOND the cuts already there. */
export type AutoTrimPlan = { cuts: Cut[]; removedSeconds: number }

/**
 * Plan a tool run against the cuts that already exist: derive the candidate
 * cuts, then drop any that change nothing (a pause the producer — or a prior
 * run — already cut). `removedSeconds` is the honest delta, measured through
 * `keptSpans` so overlaps with existing cuts aren't double-counted. Applying
 * `plan.cuts` and re-planning yields an empty plan — the tool is idempotent.
 */
export function planAutoTrim(
  spans: DeadSpan[],
  existing: Cut[],
  window: { start: number; end: number },
  knobs: Pick<AutoTrimKnobs, 'minPauseSeconds' | 'keepPaddingSeconds'>,
): AutoTrimPlan {
  const before = keptSeconds(existing, window)
  const cuts = autoTrimCuts(spans, window, knobs).filter(
    (c) => before - keptSeconds([...existing, c], window) > MIN_CUT_SECONDS,
  )
  const removed = before - keptSeconds([...existing, ...cuts], window)
  return { cuts, removedSeconds: Math.round(removed * 1000) / 1000 }
}
