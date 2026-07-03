/**
 * Stitched-playback arithmetic (story 13d).
 *
 * Play = the final cut: the original recording minus cuts (ADR-0003). Nothing
 * is rendered to preview it — the transport plays the raw media and *skips*
 * every cut span on the fly. These helpers are the pure half of that skipping
 * (where to land, what to audition, how long the result runs); the CutEditor
 * transport applies them to the `<audio>`/`<video>` elements.
 */

import type { Cut } from './scenes'
import { normalizeCuts } from './refiner'

/** Seconds of kept context an audition plays on each side of a cut. */
export const AUDITION_PAD_SECONDS = 1.5

/**
 * The first kept moment at or after `t`: `t` itself when it isn't inside any
 * cut, else the end of the cut it's in. Normalizing first merges touching /
 * overlapping cuts, so one lookup clears a whole chain of adjacent cuts.
 */
export function nextKeptTime(cuts: Cut[], t: number): number {
  for (const c of normalizeCuts(cuts)) {
    if (t >= c.start && t < c.end) return c.end
  }
  return t
}

/**
 * The span an audition of `cut` plays: ~1.5 s of footage before the cut through
 * ~1.5 s after it, clamped to the scene window. Played back stitched, the cut
 * itself is skipped — so this is the edit-listen loop: hear the seam, judge it.
 */
export function auditionSpan(
  cut: Cut,
  windowStart: number,
  windowEnd: number,
  pad = AUDITION_PAD_SECONDS,
): Cut {
  return {
    start: Math.max(windowStart, cut.start - pad),
    end: Math.min(windowEnd, cut.end + pad),
  }
}

/**
 * How long the final cut runs: the source length minus every second the cuts
 * remove. Cuts are normalized (overlaps counted once) and clamped to
 * `[0, duration]`, so a stray span outside the footage can't drive the result
 * negative.
 */
export function finalCutSeconds(cuts: Cut[], duration: number): number {
  let removed = 0
  for (const c of normalizeCuts(cuts)) {
    removed += Math.max(0, Math.min(c.end, duration) - Math.max(c.start, 0))
  }
  return Math.max(0, duration - removed)
}
