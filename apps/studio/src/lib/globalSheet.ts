import { planContactSheet, sampleTimes, MAX_SHEETS } from './contactSheet'
import { globalToLocal, totalDuration, type SourceLike } from './sources'

export type GlobalCapture = { globalTime: number; sourceId: string; localTime: number }

/**
 * Finest spacing for the whole-talk director sheet — 1 s, like the per-scene
 * refiner (`SCENE_MIN_INTERVAL_SECONDS`), NOT the 5 s clip-wide floor. We want to
 * MAXIMIZE frames within the ≤10-image / 120-frame budget: a short multi-video
 * project (e.g. 66 s) sampled at 5 s used only ~2 of 10 sheets; at 1 s it fills
 * the budget (the cap still widens the interval automatically for long talks).
 */
const GLOBAL_MIN_INTERVAL_SECONDS = 1

/**
 * Plan the whole-talk director contact sheet across many sources (story 09c).
 * Spacing is computed on the COMBINED duration with a 1 s density floor (so it
 * fills the ≤10-image budget), then each global timestamp is routed to the
 * source + local time it should be captured from. The burned-in label uses the
 * GLOBAL time so the director reads one continuous timeline.
 *
 * `perSheet`: when sheets are tiled per recording on the server (12 stills each),
 * every boundary between recordings can cost one extra sheet, and the director
 * reads only the first `MAX_SHEETS`. Passing it caps the frame count at
 * `perSheet × (MAX_SHEETS − (recordings − 1))`, which keeps
 * Σ ceil(nᵢ / perSheet) ≤ MAX_SHEETS.
 */
export function planGlobalSheetCaptures(sources: SourceLike[], perSheet?: number): GlobalCapture[] {
  const total = totalDuration(sources)
  let times = planContactSheet(total, GLOBAL_MIN_INTERVAL_SECONDS).times
  if (perSheet && perSheet > 0) {
    const recordings = sources.filter((s) => s.duration > 0).length
    const cap = perSheet * Math.max(1, MAX_SHEETS - Math.max(0, recordings - 1))
    if (times.length > cap) times = sampleTimes(total, cap)
  }
  const out: GlobalCapture[] = []
  for (const globalTime of times) {
    const local = globalToLocal(sources, globalTime)
    if (local) out.push({ globalTime, sourceId: local.sourceId, localTime: local.localTime })
  }
  return out
}
