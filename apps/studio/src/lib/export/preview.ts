/**
 * Preview — pure timeline math for the scene preview player (story 03i,
 * reshaped by ADR-0003).
 *
 * The preview SIMULATES an `AssemblePlan` (the same pure plan ffmpeg renders —
 * see ./assemble.ts) with zero rendering: the original audio plays and jumps
 * the cuts, and the flipbook maps the output clock back to original-video
 * seconds to pick a contact-sheet frame. This module is pure (no DOM, no audio
 * elements) and unit-tested; the dialog is a thin shell over it.
 *
 * Two clocks appear here:
 *  - **output time** — seconds into the stitched result (`[0, plan.duration]`).
 *  - **source time** — seconds in the original video. `planScene` rebased the
 *    plan to clip-local time, so `sceneStart` shifts between the two frames.
 */

import type { AssemblePlan } from './assemble'

/**
 * Map an output-timeline second to ORIGINAL-VIDEO seconds, for the filmstrip
 * lookup and audio seeks. Walks `plan.video` (kept source spans, clip-local
 * time) accumulating piece lengths; `sceneStart` lifts the clip-local result
 * back to the original timeline. `t` clamps to `[0, plan.duration]`; an all-cut
 * plan (no video) returns `sceneStart`.
 */
export function sourceTimeAt(plan: AssemblePlan, t: number, sceneStart: number): number {
  const last = plan.video[plan.video.length - 1]
  if (!last) return sceneStart
  const clamped = Math.min(Math.max(t, 0), plan.duration)
  let acc = 0
  for (const piece of plan.video) {
    const len = piece.end - piece.start
    if (clamped <= acc + len) return sceneStart + piece.start + (clamped - acc)
    acc += len
  }
  return sceneStart + last.end
}

/**
 * The inverse: map an original-video second to output time. A source second
 * inside a cut maps to the moment the cut collapses to (the next kept piece's
 * start — i.e. the output keeps running, footage just skipped). Before the
 * first kept piece → 0; past the last → `plan.duration`.
 */
export function outputTimeAt(plan: AssemblePlan, sourceSec: number, sceneStart: number): number {
  const local = sourceSec - sceneStart
  let acc = 0
  for (const piece of plan.video) {
    if (local < piece.start) return acc
    if (local <= piece.end) return acc + (local - piece.start)
    acc += piece.end - piece.start
  }
  return plan.duration
}

/**
 * If `sourceSec` sits inside dropped footage, the source second playback should
 * jump to (the next kept piece's start); null when it's inside kept footage.
 * Past the last kept piece returns Infinity — the caller's "stop" signal.
 */
export function nextKeptSource(plan: AssemblePlan, sourceSec: number, sceneStart: number): number | null {
  const local = sourceSec - sceneStart
  for (const piece of plan.video) {
    if (local < piece.start) return sceneStart + piece.start
    if (local < piece.end) return null
  }
  return Infinity
}
