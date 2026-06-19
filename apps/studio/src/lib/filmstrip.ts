/**
 * Build-step filmstrip gutter (story 03e) — a time-aligned column of video frames
 * down the left of the diff viewer, so the row at 0:12 shows the 0:12 frame.
 *
 * No new image generation: we reuse the director contact sheets (already
 * captured, timestamped, and uploaded) as CSS sprite sheets. `buildFilmstrip`
 * flattens every sheet's cells into a single time-sorted index; `frameAt` finds
 * the frame nearest a row's time; `spriteStyle` crops that one cell out of its
 * sheet with `background-position`. All pure — the React gutter is just a renderer.
 */

import type { CSSProperties } from 'react'
import type { ContactSheet } from './frames'

/** One cell of a contact sheet, located by time and by its index in the sheet. */
export type FilmFrame = {
  /** The original-video timestamp this frame was sampled at. */
  time: number
  /** The sheet image to crop from (bucket URL, or the local data URL pre-upload). */
  url: string
  /** The sheet the cell belongs to — carries the sprite geometry. */
  sheet: ContactSheet
  /** Cell index within the sheet (row-major), == its position in `sheet.times`. */
  index: number
}

/**
 * Flatten contact sheets into one time-sorted frame index. Pass the densest
 * sheets first (per-scene refiner sheets) followed by the whole-clip prep sheets;
 * where their time windows overlap `frameAt` picks the nearest, so the denser
 * frames naturally win inside a refined scene. Sheets with no usable image (no
 * `url` and no `dataUrl`) are skipped.
 */
export function buildFilmstrip(sheets: ContactSheet[]): FilmFrame[] {
  const frames: FilmFrame[] = []
  for (const sheet of sheets) {
    const url = sheet.url || sheet.dataUrl
    if (!url) continue
    for (let i = 0; i < sheet.times.length; i++) {
      frames.push({ time: sheet.times[i], url, sheet, index: i })
    }
  }
  frames.sort((a, b) => a.time - b.time)
  return frames
}

/**
 * The frame whose sample time is nearest `time` (binary search over the sorted
 * index). Returns null only for an empty filmstrip — otherwise a row always maps
 * to some frame, even one well before/after the sampled range.
 */
export function frameAt(frames: FilmFrame[], time: number): FilmFrame | null {
  if (frames.length === 0) return null
  if (time <= frames[0].time) return frames[0]
  const last = frames.length - 1
  if (time >= frames[last].time) return frames[last]

  let lo = 0
  let hi = last
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid].time < time) lo = mid + 1
    else hi = mid
  }
  // frames[lo].time >= time; the nearer of it and its predecessor.
  const after = frames[lo]
  const before = frames[lo - 1]
  return time - before.time <= after.time - time ? before : after
}

/**
 * The frame to show on a grid row starting at `startSec`. Frames are sampled at
 * bucket-*centred* times (e.g. 4.5s) and their burned-in clock floors that (→
 * "0:04"), so a plain nearest-by-time lookup at an even second sits between two
 * frames and can pick the earlier one ("0:03" on the 0:04 row). Instead we prefer
 * the frame whose **whole second matches the row** — the one sampled in
 * `[startSec, startSec+1)`, so its label lines up with the row's timestamp — and
 * fall back to the nearest frame only when this second has none (sparser sheets).
 */
export function frameForRow(frames: FilmFrame[], startSec: number): FilmFrame | null {
  if (frames.length === 0) return null
  const sec = Math.floor(startSec)
  // First frame at or after the start of this whole second.
  let lo = 0
  let hi = frames.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (frames[mid].time < sec) lo = mid + 1
    else hi = mid
  }
  const inSecond = frames[lo]
  if (inSecond && inSecond.time < sec + 1) return inSecond
  return frameAt(frames, startSec)
}

/**
 * A sheet's cell geometry, preferring the persisted `cellWidth/cellHeight/gap`
 * but **deriving** them from the sheet's pixel size + grid when they're absent.
 * Sheets captured before those fields were added (and rehydrated from
 * localStorage) only carry `width/height/cols/rows` — derive so they still render
 * instead of showing as blank cells, with no regeneration needed.
 */
export function cellGeometry(sheet: ContactSheet): {
  cellWidth: number
  cellHeight: number
  gap: number
} {
  // Gap has always been 2px in `composeContactSheet`; trust a stored value if set.
  const gap = sheet.gap || 2
  if (sheet.cellWidth && sheet.cellHeight) {
    return { cellWidth: sheet.cellWidth, cellHeight: sheet.cellHeight, gap }
  }
  // width = cols*cellW + (cols+1)*gap  ⇒  cellW = (width - (cols+1)*gap) / cols.
  const cellWidth = sheet.cols > 0 ? (sheet.width - (sheet.cols + 1) * gap) / sheet.cols : 0
  const cellHeight = sheet.rows > 0 ? (sheet.height - (sheet.rows + 1) * gap) / sheet.rows : 0
  return { cellWidth, cellHeight, gap }
}

/**
 * Crop `frame`'s **whole** cell out of its sheet as a CSS background, scaled to
 * `width`. Returns the cell at its full height (`width × cellHeight*scale`, a 16:9
 * frame) — the gutter renders it vertically centred in a short row and clips it
 * to a band at rest, then reveals the full frame (top + bottom) on hover. So the
 * vertical crop is the gutter's job (overflow), not this function's.
 */
export function spriteStyle(frame: FilmFrame, width: number): CSSProperties {
  const { sheet, index } = frame
  const { cols } = sheet
  const { cellWidth, cellHeight, gap } = cellGeometry(sheet)
  if (!cellWidth || !cellHeight) return { width }

  const col = cols > 0 ? index % cols : 0
  const row = cols > 0 ? Math.floor(index / cols) : 0
  const x = gap + col * (cellWidth + gap)
  const y = gap + row * (cellHeight + gap)

  const scale = width / cellWidth
  return {
    width,
    height: Math.round(cellHeight * scale),
    backgroundImage: `url(${frame.url})`,
    backgroundSize: `${Math.round(sheet.width * scale)}px ${Math.round(sheet.height * scale)}px`,
    backgroundPosition: `-${Math.round(x * scale)}px -${Math.round(y * scale)}px`,
    backgroundRepeat: 'no-repeat',
  }
}
