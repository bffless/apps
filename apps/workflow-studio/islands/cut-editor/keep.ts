/**
 * `keep` — the `trim` step's second output, and the only one the rest of the run
 * consumes: `assemble` feeds it straight to `video/slice` as the spans to keep of
 * **the scene clip**.
 *
 * Two things make it more than "not the cuts". The clip's timeline starts at 0 while
 * every span the editor deals in is in ORIGINAL-source seconds (the scene may start
 * 100 s in), so the complement has to be shifted; and a cut that runs to a scene edge
 * leaves a zero-length keep, which `video/slice` must never be asked to render.
 */
import { keptSpans } from 'studio/lib/refiner'
import type { Cut } from 'studio/lib/scenes'

/** The scene's bounds on its source's timeline. */
export interface SceneWindow {
  start: number
  end: number
}

/**
 * The spans of the scene clip to keep, in CLIP time: the complement of `cuts` inside
 * `[scene.start, scene.end]`, shifted by `-scene.start`.
 *
 * The complement itself is Studio's `keptSpans`, so the island and the Studio app
 * agree on cut normalisation (overlaps merged, sub-0.05 s spans dropped) rather than
 * having a second opinion about it here.
 */
export function keepForClip(cuts: Cut[], scene: SceneWindow): Cut[] {
  return keptSpans(cuts, scene.start, scene.end)
    .map((span) => ({ start: span.start - scene.start, end: span.end - scene.start }))
    .filter((span) => span.end > span.start)
}
