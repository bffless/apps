/**
 * Browser-side frame capture. Seeks a detached <video> to a set of timestamps
 * and draws each frame to a canvas — used for the filmstrip, to grab one
 * thumbnail per scene, and to build the director's timestamped contact sheet.
 */

import {
  planContactSheet,
  planSceneContactSheet,
  gridDimensions,
  chunk,
  clockLabel,
  type ContactSheetPlan,
} from './contactSheet'

/** Capture `count` evenly-spaced JPEG-dataURL frames across the clip. */
export async function captureFrames(
  src: string,
  duration: number,
  count: number,
  height = 48,
): Promise<string[]> {
  if (!Number.isFinite(duration) || duration <= 0 || count <= 0) return []
  const times = Array.from({ length: count }, (_, i) =>
    Math.min(duration - 0.05, (i + 0.5) * (duration / count)),
  )
  return captureFramesAt(src, times, height)
}

/** Encoding for a captured frame. Filmstrip/scene thumbs stay small JPEGs;
 * contact-sheet frames capture lossless (PNG) so they're only JPEG'd once when
 * the grid is composed — no double compression. */
export type FrameEncoding = { type?: string; quality?: number }

/** Capture one data-URL frame at each of the given timestamps (seconds). */
export async function captureFramesAt(
  src: string,
  times: number[],
  height = 48,
  { type = 'image/jpeg', quality = 0.6 }: FrameEncoding = {},
): Promise<string[]> {
  if (times.length === 0) return []

  return new Promise((resolve) => {
    const video = document.createElement('video')
    video.src = src
    video.muted = true
    video.crossOrigin = 'anonymous'
    const canvas = document.createElement('canvas')
    const out: string[] = []

    const seekTo = (i: number) => {
      if (i >= times.length) return resolve(out)
      video.currentTime = times[i]
    }

    video.addEventListener('loadeddata', () => seekTo(0))
    video.addEventListener('seeked', () => {
      const ratio = video.videoWidth / video.videoHeight || 16 / 9
      // Never capture above the source resolution — upscaling just bloats the
      // frame without adding detail (and would mask a genuinely low-res source).
      const h = Math.min(height, video.videoHeight || height)
      canvas.height = h
      canvas.width = Math.round(h * ratio)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        out.push(canvas.toDataURL(type, quality))
      }
      seekTo(out.length)
    })
    video.addEventListener('error', () => resolve(out))
  })
}

/** On-sheet cell height (px). 1280×720 cells stay sharp because the director runs
 * on Gemini, which TILES images rather than crushing them to ~1 MP. 720 is also
 * near the safe ceiling: at 3 columns that's a 3840px-wide sheet, under the
 * iOS/Safari 4096px / ~16.7 MP canvas limit (1080px cells would overflow it). */
export const CONTACT_SHEET_CELL = 720
/** Capture each frame above the cell size (capped at the source), then downscale
 * when composing — supersampling that sharpens text rather than aliasing it. */
export const CONTACT_SHEET_SUPERSAMPLE = 1.5
/** Per-image upload ceiling: Gemini 3.1 Pro allows 7 MB/image; leave headroom. */
export const MAX_SHEET_BYTES = 6_800_000

/** A composed contact sheet plus the metadata the director call needs. */
export type ContactSheet = {
  /** The composed grid as a data URL — PNG (lossless) unless size forced JPEG. */
  dataUrl: string
  width: number
  height: number
  cols: number
  rows: number
  /** One cell's drawn pixel size and the gap between cells — the geometry a CSS
   *  sprite needs to crop a single frame out of the sheet (the 03e build-step
   *  filmstrip). Derivable from `width/height/cols/rows`, but persisted so the
   *  sprite math is self-contained and survives any change to the gap/layout. */
  cellWidth: number
  cellHeight: number
  gap: number
  /** Frames actually drawn (≤ `times.length` if some captures failed). */
  count: number
  /** The original-video timestamps of this sheet's frames. */
  times: number[]
  /** Clip-wide sampling spacing (seconds) — same on every sheet. */
  interval: number
  /** Encoded byte size of `dataUrl` — kept ≤ `MAX_SHEET_BYTES`. */
  bytes: number
  /** Position in the set, for "Sheet 2 of 7". */
  index: number
  total: number
  /** Bucket URL once uploaded (story 03 feeds these to the director); the
   * `dataUrl` is the local preview, this is the persisted object. */
  url?: string
}

/** Load an image data URL into a decoded <img> element. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.addEventListener('load', () => resolve(img))
    img.addEventListener('error', reject)
    img.src = src
  })
}

/** Decoded byte size of a data URL's base64 payload. */
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',')
  const b64 = comma >= 0 ? url.slice(comma + 1) : url
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad)
}

/**
 * Encode the canvas at the best quality that fits `maxBytes`: lossless PNG first
 * (sharpest text), falling back to progressively lower-quality JPEG only if a
 * dense sheet would blow the per-image upload cap.
 */
function encodeUnderBudget(
  canvas: HTMLCanvasElement,
  maxBytes: number,
): { dataUrl: string; bytes: number } {
  const png = canvas.toDataURL('image/png')
  const pngBytes = dataUrlBytes(png)
  if (pngBytes <= maxBytes) return { dataUrl: png, bytes: pngBytes }
  let best = { dataUrl: png, bytes: pngBytes }
  for (const q of [0.92, 0.85, 0.78, 0.7, 0.6]) {
    const jpeg = canvas.toDataURL('image/jpeg', q)
    best = { dataUrl: jpeg, bytes: dataUrlBytes(jpeg) }
    if (best.bytes <= maxBytes) break
  }
  return best
}

/**
 * Compose captured frames into one contact-sheet image: a grid of cells, each
 * frame with its wall-clock timestamp burned into the corner, on a dark backing
 * so the cells read as distinct tiles. One of these per tile is handed to the
 * master director (story 03) as visual context — the timestamps let the AI map a
 * moment it sees in the footage back to an original-video time.
 *
 * Frames are assumed to share an aspect ratio (captured at one height off the
 * same video); the first decoded frame sets the cell width.
 */
export async function composeContactSheet(
  frames: string[],
  times: number[],
  cellHeight = CONTACT_SHEET_CELL,
): Promise<ContactSheet> {
  const n = Math.min(frames.length, times.length)
  const { cols, rows } = gridDimensions(n)
  const base: ContactSheet = {
    dataUrl: '',
    width: 0,
    height: 0,
    cols,
    rows,
    cellWidth: 0,
    cellHeight: 0,
    gap: 0,
    count: 0,
    times: times.slice(0, n),
    interval: 0,
    bytes: 0,
    index: 0,
    total: 1,
  }
  if (n === 0) return base

  const imgs = await Promise.all(frames.slice(0, n).map((f) => loadImage(f).catch(() => null)))
  const drawn = imgs.filter((i): i is HTMLImageElement => i !== null)
  if (drawn.length === 0) return base

  const ratio = drawn[0].width / drawn[0].height || 16 / 9
  const cellW = Math.round(cellHeight * ratio)
  const gap = 2
  const width = cols * cellW + (cols + 1) * gap
  const height = rows * cellHeight + (rows + 1) * gap

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return base

  // Frames are captured above cell size and downscaled here — high-quality
  // smoothing keeps the screen text crisp.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  ctx.fillStyle = '#111'
  ctx.fillRect(0, 0, width, height)

  const fontPx = Math.max(12, Math.round(cellHeight * 0.1))
  ctx.textBaseline = 'bottom'
  ctx.font = `600 ${fontPx}px ui-monospace, monospace`

  imgs.forEach((img, i) => {
    if (!img) return
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = gap + col * (cellW + gap)
    const y = gap + row * (cellHeight + gap)
    ctx.drawImage(img, x, y, cellW, cellHeight)

    // Burn the timestamp into the bottom-left on a translucent strip.
    const label = clockLabel(times[i] ?? 0)
    const padX = Math.round(fontPx * 0.35)
    const w = ctx.measureText(label).width + padX * 2
    const h = fontPx + padX
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(x, y + cellHeight - h, w, h)
    ctx.fillStyle = '#fff'
    ctx.fillText(label, x + padX, y + cellHeight - Math.round(padX / 2))
    ctx.fillStyle = '#111' // reset for the next cell's strip
  })

  const { dataUrl, bytes } = encodeUnderBudget(canvas, MAX_SHEET_BYTES)
  return {
    ...base,
    dataUrl,
    width,
    height,
    cellWidth: cellW,
    cellHeight,
    gap,
    count: drawn.length,
    bytes,
  }
}

/**
 * End-to-end director contact sheets: plan the interval-sampled timestamps for
 * the clip, capture each frame once, then tile them into ≤ `MAX_SHEETS` composed
 * images (so each stays under Gemini's per-image budget). Returns one
 * `ContactSheet` per tile — empty if there's nothing to sample.
 */
export async function captureContactSheet(
  src: string,
  duration: number,
  cellHeight = CONTACT_SHEET_CELL,
): Promise<ContactSheet[]> {
  return captureSheetsForPlan(src, planContactSheet(duration), cellHeight)
}

/**
 * Dense contact sheets for ONE scene's window (story 03c) — the refiner's input.
 * Same compositing as the clip-wide sheets, but the whole frame budget is spent
 * on `[start, end]` for much tighter spacing. Timestamps stay in original-video
 * seconds (the plan offsets them), so the burned-in clocks line up with the clip.
 */
export async function captureSceneContactSheet(
  src: string,
  start: number,
  end: number,
  cellHeight = CONTACT_SHEET_CELL,
): Promise<ContactSheet[]> {
  return captureSheetsForPlan(src, planSceneContactSheet(start, end), cellHeight)
}

/** Capture + compose the tiles a plan describes. Shared by the clip-wide and
 *  per-scene sheet builders. */
async function captureSheetsForPlan(
  src: string,
  plan: ContactSheetPlan,
  cellHeight: number,
): Promise<ContactSheet[]> {
  if (plan.times.length === 0 || plan.perSheet === 0) return []
  const timeTiles = chunk(plan.times, plan.perSheet)
  // Supersample: capture above the cell (capped at source by captureFramesAt),
  // downscale when composing — sharper text than capturing at cell size.
  const captureHeight = Math.round(cellHeight * CONTACT_SHEET_SUPERSAMPLE)

  // Capture + compose ONE tile at a time so we never hold more than a single
  // tile's worth of high-res frames in memory (120 1080p frames would OOM).
  const sheets: ContactSheet[] = []
  for (const tileTimes of timeTiles) {
    const frames = await captureFramesAt(src, tileTimes, captureHeight, { type: 'image/png' })
    const sheet = await composeContactSheet(frames, tileTimes, cellHeight)
    if (sheet.dataUrl) sheets.push(sheet)
  }
  // Stamp the sampling interval and tile position (compose() can't infer them).
  return sheets.map((s, i) => ({ ...s, interval: plan.interval, index: i, total: sheets.length }))
}
