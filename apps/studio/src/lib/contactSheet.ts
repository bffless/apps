/**
 * Contact-sheet planning — the pure half of the "director thumbnails" (prep
 * stage 4). We interval-sample frames across the clip and compose them into
 * timestamped grid images handed to the master director (story 03) as visual
 * context, so it can decide what footage to cut, not just rewrite the words.
 *
 * Constraints `planContactSheet` balances:
 *
 * 1. **Density** — sample as finely as `MIN_INTERVAL_SECONDS` for SHORT clips
 *    (closer than that just yields near-duplicate frames), so a short video gets
 *    plenty of frames rather than being needlessly capped at 30s.
 * 2. **Coverage** — but never sparser than `MAX_INTERVAL_SECONDS`, so long clips
 *    don't skip too much (until the frame budget forces it).
 * 3. **Per-frame detail** — the model reads each image at a bounded resolution,
 *    so a few large cells beat many tiny ones: prefer `PREFERRED_CELLS_PER_SHEET`,
 *    allow up to `MAX_CELLS_PER_SHEET`.
 * 4. **Image count** — at most `MAX_SHEETS` images per director call.
 * 5. **Upload size** — ≤ 7 MB per image (enforced in `frames.ts` at encode time).
 *
 * Net behaviour: short clips sample at ~`MIN_INTERVAL` and use as many frames as
 * that needs; once the clip is long enough to hit `MAX_FRAMES` (10 × 12 = 120)
 * the budget caps it and the spacing widens — staying ≤ 30s up to ~60 min, then
 * relaxing past it. The capture and canvas compositing live in `frames.ts`; this
 * file only decides WHICH timestamps to grab and HOW to tile them (pure + tested).
 */

/** Finest spacing we sample at — closer just yields near-duplicate frames. Drives
 * density on SHORT clips so they aren't needlessly sparse. */
export const MIN_INTERVAL_SECONDS = 5

/** Coarsest spacing we tolerate — beyond it too much is skipped. Holds until the
 * frame budget caps out (~60 min); longer clips relax past it. */
export const MAX_INTERVAL_SECONDS = 30

/** Hard cap on images sent to the director in one call. */
export const MAX_SHEETS = 10

/** Columns per sheet. Few columns ⇒ wide cells ⇒ legible after the model resize. */
export const TILE_COLUMNS = 3

/** Cells per sheet we aim for — a 3×3 grid sits just under the model's ~1 MP. */
export const PREFERRED_CELLS_PER_SHEET = 9

/** Most cells we'll pack before per-frame detail suffers (3×4). */
export const MAX_CELLS_PER_SHEET = 12

/** The largest frame budget the constraints allow: every sheet packed full. */
export const MAX_FRAMES = MAX_SHEETS * MAX_CELLS_PER_SHEET // 120

export type ContactSheetPlan = {
  /** Actual seconds between sampled frames — `MAX_INTERVAL_SECONDS` until the cap forces more. */
  interval: number
  /** All capture timestamps in seconds, evenly spread and bucket-centred. */
  times: number[]
  /** Cells per composed sheet; `times` is chunked by this into ≤ `MAX_SHEETS` tiles. */
  perSheet: number
}

/**
 * Ideal frame count: as dense as `MIN_INTERVAL_SECONDS` allows — uncapped, scales
 * with length. The plan caps the *sampled* count at `MAX_FRAMES`; this is the
 * count we'd want if image/size limits didn't exist. (Short clips get plenty of
 * frames this way instead of being pinned to the 30s coverage floor.)
 */
export function frameCount(duration: number, minInterval = MIN_INTERVAL_SECONDS): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const step = minInterval > 0 ? minInterval : MIN_INTERVAL_SECONDS
  return Math.max(1, Math.ceil(duration / step))
}

/**
 * Cells per sheet for `total` frames: the fewest that still fit within
 * `MAX_SHEETS` sheets, but never below `PREFERRED_CELLS_PER_SHEET` (so short
 * clips don't fan out into many near-empty images) nor above
 * `MAX_CELLS_PER_SHEET`. Guarantees `ceil(total / result) ≤ MAX_SHEETS`.
 */
export function cellsPerSheet(total: number): number {
  if (total <= 0) return 0
  const toFit = Math.ceil(total / MAX_SHEETS)
  return Math.min(MAX_CELLS_PER_SHEET, total, Math.max(PREFERRED_CELLS_PER_SHEET, toFit))
}

/**
 * `count` capture timestamps spread evenly across the clip, each centred in its
 * bucket (so the first/last frames aren't dead on 0:00 / the final frozen
 * frame). Kept just shy of `duration` so the seek always lands on real footage.
 */
export function sampleTimes(duration: number, count: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || count <= 0) return []
  return Array.from({ length: count }, (_, i) =>
    Math.min(duration - 0.05, (i + 0.5) * (duration / count)),
  )
}

/** Split `items` into chunks of at most `size` (the per-sheet tiling). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length ? [items] : []
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Grid for one tile: up to `TILE_COLUMNS` columns, rows grow to fit its frames.
 */
export function gridDimensions(count: number): { cols: number; rows: number } {
  if (count <= 0) return { cols: 0, rows: 0 }
  const cols = Math.min(count, TILE_COLUMNS)
  const rows = Math.ceil(count / cols)
  return { cols, rows }
}

/**
 * The clip-wide plan: how many frames to sample, their timestamps, and how many
 * cells per sheet — balancing coverage, detail, and the image cap.
 */
export function planContactSheet(
  duration: number,
  minInterval = MIN_INTERVAL_SECONDS,
): ContactSheetPlan {
  const dense = frameCount(duration, minInterval)
  if (dense === 0) return { interval: 0, times: [], perSheet: 0 }
  // Aim for `minInterval` density, never sparser than MAX_INTERVAL, never over the
  // budget. (dense ≥ coverage whenever minInterval < MAX, so the floor is
  // belt-and-braces.)
  const coverage = Math.ceil(duration / MAX_INTERVAL_SECONDS)
  const total = Math.min(MAX_FRAMES, Math.max(coverage, dense))
  return {
    interval: duration / total,
    times: sampleTimes(duration, total),
    perSheet: cellsPerSheet(total),
  }
}

/**
 * Finest spacing for a single scene's dense sheet (story 03c) — far tighter than
 * the clip-wide `MIN_INTERVAL_SECONDS` because the whole frame budget is spent on
 * ONE scene. At 1s, a scene up to `MAX_FRAMES` seconds long gets a frame every
 * second; longer scenes are capped by the budget and the spacing widens.
 */
export const SCENE_MIN_INTERVAL_SECONDS = 1

/**
 * A plan for ONE scene's dense contact sheet (story 03c). Same balancing as the
 * clip-wide plan but over the window `[start, end]` AND with a 1s density floor —
 * so a single scene packs frames densely (up to the 120-frame / 10-sheet budget)
 * instead of inheriting the clip-wide 5s spacing. That's the whole point of the
 * second pass: more frames, closer together, for sharper cut + placement calls.
 * Timestamps are offset back to original-video seconds so the burned-in clocks
 * (and the AI's answers) stay in the clip's timeline.
 */
export function planSceneContactSheet(start: number, end: number): ContactSheetPlan {
  const span = end - start
  const plan = planContactSheet(span, SCENE_MIN_INTERVAL_SECONDS)
  return { ...plan, times: plan.times.map((t) => t + start) }
}

/**
 * Clock label burned onto each frame: `m:ss`, promoting to `h:mm:ss` once the
 * clip passes an hour. Plain wall-clock (no tenths) so the director can read it
 * at thumbnail size and map a scene back to an original-video timestamp.
 */
export function clockLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = s.toString().padStart(2, '0')
  if (h) return `${h}:${m.toString().padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}
