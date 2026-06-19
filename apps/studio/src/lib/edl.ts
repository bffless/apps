/**
 * Edit Decision List (EDL) primitives.
 *
 * The editor never mutates the source video while you work. Every edit is just
 * a "cut" — a `[start, end)` range on the ORIGINAL timeline that should be
 * removed. Preview playback skips over cuts; export (a later phase) renders the
 * kept segments to a new file. These helpers are pure so they're trivial to
 * test and reason about.
 */

export type Cut = {
  id: string
  /** Inclusive start time on the original timeline, in seconds. */
  start: number
  /** Exclusive end time on the original timeline, in seconds. */
  end: number
}

/** A contiguous range, used for both cuts (removed) and kept segments. */
export type Range = { start: number; end: number }

/**
 * Sort cuts by start and merge any that touch or overlap, so downstream code
 * can assume a clean, non-overlapping, ascending list. IDs of merged cuts are
 * coalesced onto the earliest one.
 */
export function normalizeCuts(cuts: Cut[]): Cut[] {
  const sorted = [...cuts]
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start)

  const merged: Cut[] = []
  for (const cut of sorted) {
    const last = merged[merged.length - 1]
    if (last && cut.start <= last.end) {
      last.end = Math.max(last.end, cut.end)
    } else {
      merged.push({ ...cut })
    }
  }
  return merged
}

/** Total seconds removed by the given cuts (assumes they may overlap). */
export function removedDuration(cuts: Cut[]): number {
  return normalizeCuts(cuts).reduce((sum, c) => sum + (c.end - c.start), 0)
}

/** Duration of the edited result: original length minus everything cut. */
export function editedDuration(cuts: Cut[], duration: number): number {
  return Math.max(0, duration - removedDuration(cuts))
}

/**
 * If `time` falls inside a cut, return that cut — otherwise null. Used by the
 * preview player to know when to jump the playhead past removed footage.
 */
export function cutAt(cuts: Cut[], time: number): Cut | null {
  for (const c of normalizeCuts(cuts)) {
    if (time >= c.start && time < c.end) return c
  }
  return null
}

/**
 * The complement of the cuts: the ranges that survive, in order. This is what
 * export will concatenate, and what the edited timeline represents.
 */
export function keptSegments(cuts: Cut[], duration: number): Range[] {
  const segments: Range[] = []
  let cursor = 0
  for (const c of normalizeCuts(cuts)) {
    if (c.start > cursor) segments.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration) segments.push({ start: cursor, end: duration })
  return segments
}

/** Format seconds as `m:ss.t` (tenths) for compact timeline labels. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const t = Math.floor((seconds * 10) % 10)
  return `${m}:${s.toString().padStart(2, '0')}.${t}`
}
