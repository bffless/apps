/**
 * Browser-side contact-sheet capture (PR-feedback-2, reworked denser +
 * multi-sheet in PR-feedback-6 per user feedback: "10 frames is too few").
 * Grabs one frame roughly every `TARGET_INTERVAL_SECONDS`, clamped to
 * `[MIN_TILES, MAX_TILES]` tiles total, from a video — a local `File` (fresh
 * ingest) or an already-CORS-enabled URL (backfill from a signed bucket
 * download; the bucket CORS allows our origin, so canvas capture from a
 * signed URL is untainted) — and composes them into `TILES_PER_SHEET`-tile
 * sprite sheets (`SHEET_COLS`×`SHEET_ROWS`, cover-cropped to `TILE_W`×
 * `TILE_H` cells), emitting MULTIPLE sheet files when the tile count doesn't
 * fit in one (a 14-min video → ~85 tiles → 3 sheets of ≤30). Used to show a
 * preview thumbnail next to search-result moments — see `sprite.ts` for the
 * v1/v2-aware crop math on the OTHER end (sheet -> single-tile CSS
 * background) and `uploadFrameSheets` below for turning a `CaptureResult`
 * into the persisted `sheet_path`/`sheet_meta` record fields.
 *
 * Ports the seek/`seeked`-event/canvas capture idiom straight from Studio's
 * `src/lib/frames.ts` (`captureFramesAt`): a detached `<video>`, `currentTime`
 * seeks chained off `seeked` events, and a stall watchdog that resolves with
 * whatever's captured so far rather than hanging forever (a detached video
 * can stall silently, firing no `loadeddata`/`seeked`/`error` at all).
 *
 * `captureFrameSheets` NEVER rejects, same contract as Studio's
 * `captureFramesAt` ("frames are best-effort; hanging is never an option") —
 * a stalled/broken/inaccessible video resolves with `{ sheets: [] }` instead
 * of throwing, and a stall mid-way through a multi-sheet capture resolves
 * with whichever EARLIER sheets fully encoded (the current, in-progress one
 * is dropped rather than left half-drawn) rather than discarding everything.
 * Callers treat an empty `sheets` array as "skip it" — a thumbnail failure
 * never blocks the real ingest pipeline (upload/transcribe still have to run
 * either way).
 */

import { presignedUpload } from './upload'

/** Target spacing between captured frames — the density the user asked for
 * ("10 frames is too few"). */
export const TARGET_INTERVAL_SECONDS = 10
/** Never fewer tiles than this, even for a very short clip. */
export const MIN_TILES = 10
/** Hard cap regardless of clip length — bounds capture time and upload size. */
export const MAX_TILES = 120
export const SHEET_COLS = 6
export const SHEET_ROWS = 5
export const TILES_PER_SHEET = SHEET_COLS * SHEET_ROWS // 30
export const TILE_W = 320
export const TILE_H = 180
/** One sheet file: 1920×900 JPEG — well under the /api/uploads/sheet rule's 10MB cap. */
export const SHEET_PIXEL_W = SHEET_COLS * TILE_W
export const SHEET_PIXEL_H = SHEET_ROWS * TILE_H
/** Skip the first/last 2% of the clip (title cards, freeze frames) before spacing. */
export const SHEET_EDGE_TRIM_RATIO = 0.02
export const SHEET_JPEG_QUALITY = 0.8
/** Resolve with whatever's captured so far if the video makes no progress for
 * this long — mirrors Studio's `FRAME_CAPTURE_STALL_MS`. Also caps a single
 * `canvas.toBlob` encode, so an encode that never calls back can't hang
 * capture forever either. */
export const SHEET_CAPTURE_STALL_MS = 10_000

export type SheetTile = { t: number }

/** One captured-and-encoded sheet, before upload — `blob` is `null` if this
 * sheet failed to encode (dropped by the caller, same as an empty capture). */
export type CapturedSheet = { blob: Blob | null; tiles: SheetTile[] }

export type CaptureResult = {
  tileW: number
  tileH: number
  cols: number
  rows: number
  sheets: CapturedSheet[]
}

/** The record's persisted `sheet_meta` shape (v2): each sheet's OWN upload
 * URL travels with its tiles, so a client only ever needs `sheet_meta` (plus
 * whichever sheet image is relevant) to crop any tile — no cross-referencing
 * a separate manifest. `cols`/`rows`/`tileW`/`tileH` are shared across every
 * sheet (same capture grid throughout). See `sprite.ts` for how this (and
 * the older v1 single-sheet shape) get read back. */
export type SheetMetaV2 = {
  v: 2
  tileW: number
  tileH: number
  cols: number
  rows: number
  sheets: { url: string; tiles: SheetTile[] }[]
}

const GRID = { cols: SHEET_COLS, rows: SHEET_ROWS, tileW: TILE_W, tileH: TILE_H }

/**
 * Tiles to capture for a clip of `duration` seconds: as close to one every
 * `TARGET_INTERVAL_SECONDS` as possible, clamped to `[MIN_TILES, MAX_TILES]`.
 * A 14-minute video (840s / 10s ≈ 84) lands at 84 tiles, comfortably under
 * the 120 cap; a 30s clip clamps up to the 10-tile floor; a multi-hour clip
 * clamps down to 120 (spacing widens past 10s to stay there).
 */
export function tileCount(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const target = Math.round(duration / TARGET_INTERVAL_SECONDS)
  return Math.min(MAX_TILES, Math.max(MIN_TILES, target))
}

/**
 * `n` timestamps (seconds), evenly spaced INCLUSIVE of both ends, across the
 * middle `1 - 2*SHEET_EDGE_TRIM_RATIO` of `duration` — skips the first and
 * last `SHEET_EDGE_TRIM_RATIO` (2%), then spaces `n` points evenly across
 * what's left. Returns `[]` for an invalid duration/count.
 */
export function sheetTimestamps(duration: number, n: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || n <= 0) return []
  const trim = duration * SHEET_EDGE_TRIM_RATIO
  const start = trim
  const end = Math.max(start, duration - trim)
  if (n === 1) return [(start + end) / 2]
  const span = end - start
  return Array.from({ length: n }, (_, i) => start + (span * i) / (n - 1))
}

/** Split `items` into chunks of at most `size` (how tiles get packed into
 * sheet files) — the last chunk may be shorter. */
export function chunkTimes<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length ? [items] : []
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
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

/** Wrap `canvas.toBlob` in a promise that resolves `null` (rather than
 * hanging) if the callback is never invoked within `SHEET_CAPTURE_STALL_MS`
 * — belt-and-braces alongside the capture loop's own watchdog, since a
 * canvas encode is a separate async operation the seek-chain watchdog
 * doesn't otherwise cover. */
function encodeCanvas(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (blob: Blob | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(blob)
    }
    const timer = setTimeout(() => finish(null), SHEET_CAPTURE_STALL_MS)
    try {
      canvas.toBlob((blob) => finish(blob), 'image/jpeg', SHEET_JPEG_QUALITY)
    } catch {
      finish(null)
    }
  })
}

/**
 * Capture `tileCount(duration)` evenly-spaced frames from `source`, packed
 * `TILES_PER_SHEET` to a sheet, and compose each sheet into its own JPEG
 * (quality `SHEET_JPEG_QUALITY`). `source` is a local `File` (no
 * `crossOrigin` needed — same-origin blob URL) or a URL string (captured
 * with `crossOrigin = 'anonymous'`, since it's expected to be a signed
 * bucket URL the CORS policy allows our origin to read).
 *
 * Never rejects — see the module doc for why.
 */
export async function captureFrameSheets(source: File | string): Promise<CaptureResult> {
  const isLocalFile = source instanceof File
  const objectUrl = isLocalFile ? URL.createObjectURL(source) : null
  const src = objectUrl ?? (source as string)
  try {
    const sheets = await captureFromSrc(src, isLocalFile)
    return { tileW: TILE_W, tileH: TILE_H, cols: SHEET_COLS, rows: SHEET_ROWS, sheets }
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

function captureFromSrc(src: string, isLocalFile: boolean): Promise<CapturedSheet[]> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    if (!isLocalFile) video.crossOrigin = 'anonymous'

    let aborted = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let interrupt: (() => void) | null = null

    const giveUp = () => {
      if (aborted) return
      aborted = true
      clearTimeout(watchdog)
      interrupt?.()
    }

    const kick = () => {
      if (aborted) return
      clearTimeout(watchdog)
      watchdog = setTimeout(giveUp, SHEET_CAPTURE_STALL_MS)
    }

    /** Wait for the first of `events` (success) or `error` (failure) to fire
     * on `video`, arming the stall watchdog for the wait — `onArmed` (if
     * given) runs AFTER listeners are attached, so triggering the awaited
     * condition (e.g. setting `currentTime`) can never race the listener. */
    function waitFor(events: string[], armProgress: boolean, onArmed?: () => void): Promise<boolean> {
      return new Promise((res) => {
        if (aborted) return res(false)
        let done = false
        const finish = (ok: boolean) => {
          if (done) return
          done = true
          cleanup()
          res(ok)
        }
        const onOk = () => finish(true)
        const onErr = () => finish(false)
        function cleanup() {
          for (const ev of events) video.removeEventListener(ev, onOk)
          video.removeEventListener('error', onErr)
          if (armProgress) video.removeEventListener('progress', kick)
          interrupt = null
        }
        interrupt = () => finish(false)
        for (const ev of events) video.addEventListener(ev, onOk)
        video.addEventListener('error', onErr)
        if (armProgress) video.addEventListener('progress', kick)
        kick()
        onArmed?.()
      })
    }

    async function run(): Promise<CapturedSheet[]> {
      video.src = src
      const loaded = await waitFor(['loadeddata'], true)
      if (!loaded || aborted) return []

      const n = tileCount(video.duration)
      const allTimes = sheetTimestamps(video.duration, n)
      if (allTimes.length === 0) return []
      const sheetsTimes = chunkTimes(allTimes, TILES_PER_SHEET)

      const doneSheets: CapturedSheet[] = []
      for (const times of sheetsTimes) {
        const canvas = document.createElement('canvas')
        canvas.width = SHEET_PIXEL_W
        canvas.height = SHEET_PIXEL_H
        const ctx = canvas.getContext('2d')

        let drawn = 0
        for (let i = 0; i < times.length; i++) {
          const t = times[i]
          const ok = await waitFor(['seeked'], false, () => {
            video.currentTime = t
          })
          if (!ok || aborted) break
          try {
            if (ctx) {
              const rect = tileRect(i, GRID)
              const crop = coverCropRect(
                video.videoWidth || TILE_W,
                video.videoHeight || TILE_H,
                rect.w,
                rect.h,
              )
              ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, rect.x, rect.y, rect.w, rect.h)
            }
            drawn++
          } catch {
            break
          }
        }

        if (drawn > 0) {
          const blob = await encodeCanvas(canvas)
          doneSheets.push({ blob, tiles: times.slice(0, drawn).map((t) => ({ t })) })
        }
        if (aborted) break
      }
      return doneSheets
    }

    run().then(resolve)
  })
}

/**
 * Upload every captured sheet through the existing `/api/uploads/sheet`
 * prepare/register pair (looped — one presigned PUT per sheet file) and
 * assemble the v2 `sheet_meta` JSON. Sheets with no blob (a partial-failure
 * edge case from `captureFrameSheets`) are skipped; if every sheet fails to
 * upload/has no blob, returns `null` (caller treats this the same as "no
 * capture at all" — skip saving anything).
 *
 * `sheet_path` (the record's cheap existence/back-compat field) is always
 * the FIRST successfully uploaded sheet's URL.
 */
export async function uploadFrameSheets(
  captured: CaptureResult,
  videoId: string,
): Promise<{ sheet_path: string; sheet_meta: string } | null> {
  const uploaded: SheetMetaV2['sheets'] = []

  for (let i = 0; i < captured.sheets.length; i++) {
    const sheet = captured.sheets[i]
    if (!sheet.blob || sheet.tiles.length === 0) continue
    const file = new File([sheet.blob], `sheet-${i}.jpg`, { type: 'image/jpeg' })
    const url = await presignedUpload(file, '/api/uploads/sheet', videoId)
    uploaded.push({ url, tiles: sheet.tiles })
  }

  if (uploaded.length === 0) return null

  const meta: SheetMetaV2 = {
    v: 2,
    tileW: captured.tileW,
    tileH: captured.tileH,
    cols: captured.cols,
    rows: captured.rows,
    sheets: uploaded,
  }
  return { sheet_path: uploaded[0].url, sheet_meta: JSON.stringify(meta) }
}
