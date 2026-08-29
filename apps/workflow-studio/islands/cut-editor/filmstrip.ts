/**
 * The filmstrip gutter's input. Studio's `CutEditor` takes `FilmFrame[]` — one entry
 * per contact-sheet cell, each carrying the sheet's sprite geometry so the row at 0:12
 * can crop the 0:12 frame out of the sheet image with `background-position`.
 *
 * In Studio those sheets are composed in the browser, so their geometry is known by
 * construction. Here they arrive as `sheets` (a list of `FileRef`s — this source's leg of
 * the `sheets` matrix job) plus `times` (R118 — one array of capture seconds per sheet,
 * parallel to it). Either may be null or empty when that recording's capture was skipped
 * (R147), which just means an empty gutter. Everything else has to be reconstructed from
 * what CE's tiler actually does, plus the image's own pixel size.
 *
 * ## CE's real sheet geometry (R143)
 *
 * `video/contact-sheet` runs CE's ffmpeg `frames` op with `tile: { perSheet: 12,
 * columns: 3 }`, and CE emits
 * `tile=${cols}x${rows}:padding=2:margin=2:color=0x111111`
 * (`buildTileArgs`, `apps/backend/src/pipelines/ffmpeg/ffmpeg-args.ts`). So the sheet
 * is NOT gapless: ffmpeg's `tile` puts a 2 px **margin** around the outside and 2 px of
 * **padding** between adjacent cells —
 *
 *     width  = cols * cellWidth  + (cols - 1) * padding + 2 * margin
 *     cell x = margin + col * (cellWidth + padding)
 *
 * Studio's `cellGeometry`/`spriteStyle` model a single uniform `gap` on every edge:
 * `width = cols * cellWidth + (cols + 1) * gap` and `x = gap + col * (cellWidth + gap)`.
 * Because CE sets **margin === padding === 2**, the two are the same arithmetic — the
 * Studio model is exact here, with `gap = 2`. (If CE ever made them differ, this
 * mapping would no longer be exact and the sheet would need its own geometry rather
 * than Studio's one-gap model; that is the assumption this file rests on.)
 *
 * `cols` is per-sheet, not the `columns` knob: CE's planner lays a short final sheet
 * out at its own narrower width (`cols = min(chunk.length, columns)` in
 * `ffmpeg.handler.ts`'s `planSheets`), and `buildTileArgs` is handed that value.
 *
 * `cellWidth`/`cellHeight` are computed here rather than left at 0 for
 * `cellGeometry` to derive: `CutEditor` also reads `sheet.cellWidth`/`cellHeight`
 * DIRECTLY for its tall-rows height (`CutEditor.tsx`'s `fullRowHeight` — a falsy
 * `cellWidth` collapses every row to the 32 px band). The numbers are exactly what
 * `cellGeometry` would derive; this way both readers get them.
 *
 * The frames' `time` values are the SOURCE's own clock — the same one `scene.start`/
 * `scene.end` and the transcript words are in, which is what `frameForRow` looks them
 * up by.
 */
import { buildFilmstrip, type FilmFrame } from 'studio/lib/filmstrip'
import type { ContactSheet } from 'studio/lib/frames'

/** CE's contact-sheet `columns` knob (`video/contact-sheet`'s rule: `tile.columns`). */
export const SHEET_COLS = 3

/** ffmpeg's `tile=…:padding=2:margin=2` — equal, so Studio's one-gap model is exact. */
export const SHEET_GAP = 2

/** One signed sheet, once its pixel size is known. */
export interface SheetImage {
  /** The presigned URL — what the `<div>`'s `background-image` points at. */
  url: string
  /** The capture seconds of this sheet's cells, row-major (R118's `times[i]`). */
  times: number[]
  width: number
  height: number
}

/**
 * A `ContactSheet` for one signed sheet. `dataUrl` is empty because there is no local
 * preview here — `buildFilmstrip` takes `sheet.url || sheet.dataUrl`, and the URL is
 * what we have.
 */
export function toContactSheet(sheet: SheetImage, index: number, total: number): ContactSheet {
  const cols = Math.min(SHEET_COLS, Math.max(1, sheet.times.length))
  const rows = Math.max(1, Math.ceil(sheet.times.length / cols))
  return {
    dataUrl: '',
    url: sheet.url,
    width: sheet.width,
    height: sheet.height,
    cols,
    rows,
    // width = cols*cellWidth + (cols+1)*gap  ⇒  cellWidth = (width - (cols+1)*gap)/cols
    cellWidth: (sheet.width - (cols + 1) * SHEET_GAP) / cols,
    cellHeight: (sheet.height - (rows + 1) * SHEET_GAP) / rows,
    gap: SHEET_GAP,
    count: sheet.times.length,
    times: sheet.times,
    interval: sheet.times.length > 1 ? sheet.times[1] - sheet.times[0] : 0,
    bytes: 0,
    index,
    total,
  }
}

/** Every sheet's cells, flattened into one time-sorted index (Studio's own). */
export function framesFor(sheets: SheetImage[]): FilmFrame[] {
  return buildFilmstrip(sheets.map((sheet, i) => toContactSheet(sheet, i, sheets.length)))
}

/**
 * The sheet image's intrinsic size — the one thing about a sheet only the browser
 * knows. Rejects rather than hanging on an image that never loads, so a broken sheet
 * costs the gutter, not the step.
 */
export function measureSheet(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error(`could not load contact sheet ${url}`))
    image.src = url
  })
}
