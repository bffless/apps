import { planContactSheet, sampleTimes, MAX_SHEETS } from './contactSheet'
import { globalToLocal, sourceOffsets, totalDuration, type SourceLike } from './sources'

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
 * Split `sheets` whole contact sheets across recordings by length. Every recording with
 * a positive duration gets at least one; the rest go by largest remainder (ties → earlier
 * recording). With more recordings than sheets, the `sheets` LONGEST recordings (ties →
 * earlier) get one each and the rest get 0 — the caller names them, never drops them silently.
 */
export function allocateSheets(durations: number[], sheets = MAX_SHEETS): number[] {
  const out = durations.map(() => 0)
  const live = durations
    .map((d, i) => ({ d: Number.isFinite(d) && d > 0 ? d : 0, i }))
    .filter((x) => x.d > 0)
  if (live.length === 0 || sheets <= 0) return out
  if (live.length > sheets) {
    for (const x of [...live].sort((a, b) => b.d - a.d || a.i - b.i).slice(0, sheets)) out[x.i] = 1
    return out
  }
  for (const x of live) out[x.i] = 1
  const spare = sheets - live.length
  const total = live.reduce((n, x) => n + x.d, 0)
  const shares = live.map((x) => ({ i: x.i, exact: (spare * x.d) / total }))
  let given = 0
  for (const s of shares) {
    const whole = Math.floor(s.exact)
    out[s.i] += whole
    given += whole
  }
  const byRemainder = [...shares].sort(
    (a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || a.i - b.i,
  )
  for (let r = 0; r < spare - given; r++) out[byRemainder[r].i] += 1
  return out
}

/**
 * Plan the whole-talk director contact sheet across many sources (story 09c).
 * Spacing is computed on the COMBINED duration with a 1 s density floor (so it
 * fills the ≤10-image budget), then each global timestamp is routed to the
 * source + local time it should be captured from. The burned-in label uses the
 * GLOBAL time so the director reads one continuous timeline.
 *
 * `perSheet`: when sheets are tiled per recording on the server (12 stills each),
 * the frames for each recording are chunked into their own sheets, so the
 * director's ≤`MAX_SHEETS` image budget has to be split ACROSS recordings, not
 * just across frames. Passing it allocates `MAX_SHEETS` whole sheets across the
 * recordings by length (`allocateSheets`) — every recording with a positive
 * duration gets at least one, longer recordings get more — then samples each
 * recording's own share of the frame budget, capped at what its sheets can
 * hold. This guarantees Σ ceil(nᵢ / perSheet) ≤ Σ sheetsᵢ ≤ MAX_SHEETS for any
 * number of recordings: past `MAX_SHEETS` recordings, the shortest ones get no
 * sheet at all (and no captures) rather than every recording being squeezed to
 * a sliver.
 */
export function planGlobalSheetCaptures(sources: SourceLike[], perSheet?: number): GlobalCapture[] {
  const total = totalDuration(sources)
  if (!perSheet || perSheet <= 0) {
    const times = planContactSheet(total, GLOBAL_MIN_INTERVAL_SECONDS).times
    const out: GlobalCapture[] = []
    for (const globalTime of times) {
      const local = globalToLocal(sources, globalTime)
      if (local) out.push({ globalTime, sourceId: local.sourceId, localTime: local.localTime })
    }
    return out
  }
  const budget = planContactSheet(total, GLOBAL_MIN_INTERVAL_SECONDS).times.length
  if (budget === 0) return []
  const spans = sourceOffsets(sources)
  const sheets = allocateSheets(spans.map((s) => s.end - s.start))
  const out: GlobalCapture[] = []
  spans.forEach((span, i) => {
    const d = span.end - span.start
    if (d <= 0 || sheets[i] <= 0) return
    const share = Math.max(1, Math.round((budget * d) / total))
    const n = Math.min(sheets[i] * perSheet, share)
    for (const localTime of sampleTimes(d, n)) {
      out.push({ globalTime: span.start + localTime, sourceId: span.id, localTime })
    }
  })
  return out
}
