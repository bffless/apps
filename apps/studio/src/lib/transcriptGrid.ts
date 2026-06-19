/**
 * Lay a word-level transcript out on a time grid, the way the transcript editor
 * renders it. Each row ("line") spans `secondsPerLine` seconds; within a row,
 * time is sliced into `segmentSeconds`-wide cells (columns) — tenth-seconds by
 * default, since people speak 2–3 words a second and one-second cells pile them
 * up. A word is dropped into the cell for the slice its `start` falls in, so
 * reading left→right then top→bottom walks the audio forward in time.
 *
 * Pure + deterministic so it's trivial to unit-test; the React component is just
 * a renderer over `buildTranscriptGrid`.
 */

export type TWord = { text: string; start: number; end: number; speaker?: string }

/** A dropped footage span, in seconds — drawn as red cells on the grid. */
export type CutSpan = { start: number; end: number }

/** One time-slice column in a row: the words that begin during that slice. */
export type GridCell = TWord[]

export type GridLine = {
  /** Row index, 0-based. */
  index: number
  /** Absolute second this row starts at (`index * secondsPerLine`). */
  startSec: number
  /** `secondsPerLine / segmentSeconds` cells, one per slice, left→right. */
  cells: GridCell[]
}

/** Lines default to 2 seconds; the editor lets you change it. */
export const DEFAULT_SECONDS_PER_LINE = 2

/** Cells default to a tenth-second slice; the editor lets you change it. */
export const DEFAULT_SEGMENT_SECONDS = 0.1

const emptyCells = (n: number): GridCell[] => Array.from({ length: n }, () => [])

/** How many cells a row has at the given line/segment sizes (>= 1). */
export function segmentsPerLine(
  secondsPerLine: number = DEFAULT_SECONDS_PER_LINE,
  segmentSeconds: number = DEFAULT_SEGMENT_SECONDS,
): number {
  const perLine = Math.max(1, secondsPerLine)
  const seg = segmentSeconds > 0 ? segmentSeconds : DEFAULT_SEGMENT_SECONDS
  return Math.max(1, Math.round(perLine / seg))
}

/**
 * Bucket `words` into rows of `secondsPerLine` seconds, each sliced into
 * `segmentSeconds`-wide cells. Rows with no words are still emitted (empty) so
 * the grid stays continuous from 0 up to the last word — gaps in speech read as
 * blank space, like silence.
 *
 * Words keep their input order within a cell, so a transcript already sorted by
 * `start` reads naturally. Negative starts clamp to 0; a word landing exactly on
 * the row boundary clamps into the last cell of its row.
 *
 * `minSeconds` forces the grid to span at least that long even past the last
 * word — so two panes can be pinned to the same height, and a trailing cut with
 * no words underneath still has rows to render on.
 */
export function buildTranscriptGrid(
  words: TWord[],
  secondsPerLine: number = DEFAULT_SECONDS_PER_LINE,
  segmentSeconds: number = DEFAULT_SEGMENT_SECONDS,
  minSeconds = 0,
): GridLine[] {
  const perLine = Math.max(1, secondsPerLine)
  const seg = segmentSeconds > 0 ? segmentSeconds : DEFAULT_SEGMENT_SECONDS
  const cols = segmentsPerLine(perLine, seg)

  const byLine = new Map<number, GridCell[]>()
  let maxLine = -1

  for (const w of words) {
    const at = Math.max(0, w.start)
    const line = Math.floor(at / perLine)
    const within = at - line * perLine
    const col = Math.min(cols - 1, Math.floor(within / seg))
    if (line > maxLine) maxLine = line

    let cells = byLine.get(line)
    if (!cells) {
      cells = emptyCells(cols)
      byLine.set(line, cells)
    }
    cells[col].push(w)
  }

  // Extend to `minSeconds` so both diff panes stay the same height and trailing
  // cuts (which have no words) still get rows.
  if (Number.isFinite(minSeconds) && minSeconds > 0) {
    const minLine = Math.ceil(minSeconds / perLine) - 1
    if (minLine > maxLine) maxLine = minLine
  }

  const lines: GridLine[] = []
  for (let i = 0; i <= maxLine; i++) {
    lines.push({
      index: i,
      startSec: i * perLine,
      cells: byLine.get(i) ?? emptyCells(cols),
    })
  }
  return lines
}

/**
 * Drop grid lines outside a scene window `[windowStart, windowEnd)` on the
 * absolute timeline — so the diff viewer shows only the selected scene and
 * switching `SceneTabs` re-scopes it (story 03c "per-scene scope"). Timestamps
 * stay absolute: scene 2 reads from 1:44, matching the scene's footage span and
 * the cut/segment model. `windowStart` floors to its line so the row holding the
 * scene start is kept. The defaults (0 / Infinity) are a no-op — the whole grid.
 *
 * Apply it identically to both panes and the filmstrip (same `secondsPerLine`)
 * so they stay row-aligned after cropping.
 */
export function windowLines(
  lines: GridLine[],
  windowStart = 0,
  windowEnd = Infinity,
  secondsPerLine: number = DEFAULT_SECONDS_PER_LINE,
): GridLine[] {
  const perLine = Math.max(1, secondsPerLine)
  const firstLine = Math.floor(Math.max(0, windowStart) / perLine)
  return lines.filter((l) => l.index >= firstLine && l.startSec < windowEnd)
}

/** `m:ss` clock label for a row's start second (line "numbers" are timestamps). */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}:${rem.toString().padStart(2, '0')}`
}

/**
 * For one row, which columns fall inside a cut span — so the renderer can fill
 * those cells red. A cell covers `[startSec + col*seg, +seg)`; it's cut if that
 * slice overlaps any cut span at all.
 *
 * Overlaps under a microsecond don't count: a span snapped to the grid builds
 * its ends by different arithmetic than the cell boundaries here (52 + 3*0.1
 * vs 52 + 2*0.1 + 0.1 differ by ~1 ulp), and a strict test would flag the
 * neighbouring cell too.
 */
const OVERLAP_EPS = 1e-6

export function cutColumns(
  startSec: number,
  cols: number,
  segmentSeconds: number = DEFAULT_SEGMENT_SECONDS,
  cuts: CutSpan[] = [],
): boolean[] {
  const seg = segmentSeconds > 0 ? segmentSeconds : DEFAULT_SEGMENT_SECONDS
  const out: boolean[] = new Array(cols).fill(false)
  if (!cuts.length) return out
  for (let col = 0; col < cols; col++) {
    const cellStart = startSec + col * seg
    const cellEnd = cellStart + seg
    for (const c of cuts) {
      if (cellEnd > c.start + OVERLAP_EPS && cellStart < c.end - OVERLAP_EPS) {
        out[col] = true
        break
      }
    }
  }
  return out
}

/**
 * Which row + column the playhead is in, given the line/segment sizes. Returns
 * null before 0. Used to highlight the current cell as the video plays.
 */
export function gridPosition(
  time: number,
  secondsPerLine: number = DEFAULT_SECONDS_PER_LINE,
  segmentSeconds: number = DEFAULT_SEGMENT_SECONDS,
): { line: number; col: number } | null {
  if (!Number.isFinite(time) || time < 0) return null
  const perLine = Math.max(1, secondsPerLine)
  const seg = segmentSeconds > 0 ? segmentSeconds : DEFAULT_SEGMENT_SECONDS
  const cols = segmentsPerLine(perLine, seg)
  const line = Math.floor(time / perLine)
  const within = time - line * perLine
  const col = Math.min(cols - 1, Math.floor(within / seg))
  return { line, col }
}
