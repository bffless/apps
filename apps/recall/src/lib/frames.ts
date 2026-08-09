/**
 * Browser-side contact-sheet capture (PR-feedback-2): grabs `SHEET_FRAME_COUNT`
 * evenly-spaced frames from a video — a local `File` (fresh ingest) or an
 * already-CORS-enabled URL (backfill from a signed bucket download; the
 * bucket CORS allows our origin, so canvas capture from a signed URL is
 * untainted) — and composes them into ONE `SHEET_COLS`×`SHEET_ROWS` sprite
 * sheet, cover-cropped to `TILE_W`×`TILE_H` cells. Used to show a small
 * preview thumbnail next to search-result moments — see `sprite.ts` for the
 * crop math on the OTHER end (sheet -> single-tile CSS background).
 *
 * Ports the seek/`seeked`-event/canvas capture idiom straight from Studio's
 * `src/lib/frames.ts` (`captureFramesAt`): a detached `<video>`, `currentTime`
 * seeks chained off `seeked` events, and a stall watchdog that resolves with
 * whatever's captured so far rather than hanging forever (a detached video
 * can stall silently, firing no `loadeddata`/`seeked`/`error` at all).
 *
 * `captureFrameSheet` NEVER rejects, same contract as Studio's
 * `captureFramesAt` ("frames are best-effort; hanging is never an option") —
 * a stalled/broken/inaccessible video resolves with `{ blob: null, meta:
 * { ..., tiles: [] } }` instead of throwing, so a thumbnail failure never
 * blocks the real ingest pipeline (the upload/transcribe stages still have to
 * run either way). Callers treat a `null` blob / empty `tiles` as "skip it."
 */

export const SHEET_FRAME_COUNT = 10
export const SHEET_COLS = 5
export const SHEET_ROWS = 2
export const TILE_W = 320
export const TILE_H = 180
/** Skip the first/last 2% of the clip (title cards, freeze frames) before spacing. */
export const SHEET_EDGE_TRIM_RATIO = 0.02
export const SHEET_JPEG_QUALITY = 0.8
/** Resolve with whatever's captured so far if the video makes no progress for
 * this long — mirrors Studio's `FRAME_CAPTURE_STALL_MS`. */
export const SHEET_CAPTURE_STALL_MS = 10_000

export type SheetTile = { t: number }
export type SheetMeta = {
  cols: number
  rows: number
  tileW: number
  tileH: number
  tiles: SheetTile[]
}
export type SheetResult = { blob: Blob | null; meta: SheetMeta }

const GRID = { cols: SHEET_COLS, rows: SHEET_ROWS, tileW: TILE_W, tileH: TILE_H }

function emptyMeta(): SheetMeta {
  return { ...GRID, tiles: [] }
}

/**
 * `n` timestamps (seconds), evenly spaced INCLUSIVE of both ends, across the
 * middle `1 - 2*SHEET_EDGE_TRIM_RATIO` of `duration` — skips the first and
 * last `SHEET_EDGE_TRIM_RATIO` (2%), then spaces `n` points evenly across
 * what's left. Returns `[]` for an invalid duration/count.
 */
export function sheetTimestamps(duration: number, n: number = SHEET_FRAME_COUNT): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || n <= 0) return []
  const trim = duration * SHEET_EDGE_TRIM_RATIO
  const start = trim
  const end = Math.max(start, duration - trim)
  if (n === 1) return [(start + end) / 2]
  const span = end - start
  return Array.from({ length: n }, (_, i) => start + (span * i) / (n - 1))
}

/** Pixel rect for tile `index` in a `cols`×`rows` grid of `tileW`×`tileH` cells. */
export function tileRect(
  index: number,
  meta: { cols: number; rows: number; tileW: number; tileH: number },
): { x: number; y: number; w: number; h: number } {
  const cols = Math.max(1, meta.cols)
  const col = index % cols
  const row = Math.floor(index / cols)
  return { x: col * meta.tileW, y: row * meta.tileH, w: meta.tileW, h: meta.tileH }
}

/**
 * The largest centered `destW×destH`-ratio window that fits inside a
 * `sourceW×sourceH` frame — a "cover" crop (crop the source's edges to match
 * the target aspect ratio, no squashing). Used to letterbox a non-16:9 source
 * frame into a 16:9 tile.
 */
export function coverCropRect(
  sourceW: number,
  sourceH: number,
  destW: number,
  destH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  if (sourceW <= 0 || sourceH <= 0 || destW <= 0 || destH <= 0) {
    return { sx: 0, sy: 0, sw: Math.max(0, sourceW), sh: Math.max(0, sourceH) }
  }
  const sourceRatio = sourceW / sourceH
  const destRatio = destW / destH
  if (sourceRatio > destRatio) {
    // Source is relatively wider than the target tile — crop its left/right.
    const sw = sourceH * destRatio
    return { sx: (sourceW - sw) / 2, sy: 0, sw, sh: sourceH }
  }
  // Source is relatively taller (or equal) — crop its top/bottom.
  const sh = sourceW / destRatio
  return { sx: 0, sy: (sourceH - sh) / 2, sw: sourceW, sh }
}

/**
 * Capture `SHEET_FRAME_COUNT` evenly-spaced frames from `source` and compose
 * them into one sprite sheet (JPEG, quality `SHEET_JPEG_QUALITY`). `source`
 * is a local `File` (no `crossOrigin` needed — same-origin blob URL) or a URL
 * string (captured with `crossOrigin = 'anonymous'`, since it's expected to
 * be a signed bucket URL the CORS policy allows our origin to read).
 *
 * Never rejects — see the module doc for why.
 */
export async function captureFrameSheet(source: File | string): Promise<SheetResult> {
  const isLocalFile = source instanceof File
  const objectUrl = isLocalFile ? URL.createObjectURL(source) : null
  const src = objectUrl ?? (source as string)
  try {
    return await captureFromSrc(src, isLocalFile)
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

function captureFromSrc(src: string, isLocalFile: boolean): Promise<SheetResult> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    if (!isLocalFile) video.crossOrigin = 'anonymous'
    video.src = src

    const canvas = document.createElement('canvas')
    canvas.width = GRID.cols * GRID.tileW
    canvas.height = GRID.rows * GRID.tileH
    const ctx = canvas.getContext('2d')

    let times: number[] = []
    let drawn = 0
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | undefined

    const finish = (blob: Blob | null, tiles: SheetTile[]) => {
      if (settled) return
      settled = true
      clearTimeout(watchdog)
      resolve({ blob, meta: { ...GRID, tiles } })
    }
    const failEmpty = () => finish(null, [])

    const kick = () => {
      if (settled) return
      clearTimeout(watchdog)
      watchdog = setTimeout(failEmpty, SHEET_CAPTURE_STALL_MS)
    }
    kick()

    const encodeAndFinish = () => {
      try {
        if (!ctx || drawn === 0) return failEmpty()
        canvas.toBlob(
          (blob) => finish(blob, times.map((t) => ({ t }))),
          'image/jpeg',
          SHEET_JPEG_QUALITY,
        )
      } catch {
        failEmpty()
      }
    }

    const seekTo = (i: number) => {
      if (settled) return
      if (i >= times.length) return encodeAndFinish()
      kick()
      video.currentTime = times[i]
    }

    video.addEventListener('loadedmetadata', () => {
      if (settled) return
      kick()
      times = sheetTimestamps(video.duration, SHEET_FRAME_COUNT)
      if (times.length === 0) failEmpty()
    })
    video.addEventListener('loadeddata', () => {
      if (settled) return
      try {
        if (times.length === 0) times = sheetTimestamps(video.duration, SHEET_FRAME_COUNT)
        if (times.length === 0) return failEmpty()
        seekTo(0)
      } catch {
        failEmpty()
      }
    })
    video.addEventListener('progress', kick)
    video.addEventListener('seeked', () => {
      if (settled) return
      try {
        if (ctx) {
          const rect = tileRect(drawn, GRID)
          const crop = coverCropRect(video.videoWidth || GRID.tileW, video.videoHeight || GRID.tileH, rect.w, rect.h)
          ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, rect.x, rect.y, rect.w, rect.h)
        }
        drawn++
        seekTo(drawn)
      } catch {
        failEmpty()
      }
    })
    video.addEventListener('error', failEmpty)
  })
}

export { emptyMeta as emptySheetMeta }
