import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  sheetTimestamps,
  tileRect,
  coverCropRect,
  captureFrameSheet,
  SHEET_FRAME_COUNT,
  SHEET_COLS,
  SHEET_ROWS,
  TILE_W,
  TILE_H,
  SHEET_CAPTURE_STALL_MS,
} from './frames'

/**
 * `captureFrameSheet` must never leave its promise unsettled — same
 * stall-hardening contract as Studio's `captureFramesAt`. jsdom never fires
 * real media/canvas events (`getContext('2d')` returns `null`, `toBlob`
 * never invokes its callback — verified against this repo's jsdom version),
 * which makes it exactly the pathological video these tests need; they only
 * exercise the video-event-driven paths, same as Studio's `frames.test.ts`.
 * The pure timestamp/geometry math below is what's actually asserted on
 * pixel-accurate values.
 */

/** Intercept the <video> element captureFrameSheet creates so a test can fire
 *  media events on it. */
function trapVideo(): { get: () => HTMLVideoElement } {
  let video: HTMLVideoElement | null = null
  const orig = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = orig(tag)
    if (tag === 'video') video = el as HTMLVideoElement
    return el
  }) as typeof document.createElement)
  return {
    get: () => {
      if (!video) throw new Error('captureFrameSheet created no <video>')
      return video
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sheetTimestamps', () => {
  it('spaces SHEET_FRAME_COUNT points evenly, inclusive of the trimmed edges', () => {
    const times = sheetTimestamps(100, 10)
    expect(times).toHaveLength(10)
    expect(times[0]).toBeCloseTo(2, 5) // 2% of 100
    expect(times[9]).toBeCloseTo(98, 5) // 100 - 2%
    // Evenly spaced: constant gap between consecutive points.
    const gap = times[1] - times[0]
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(gap, 5)
    }
  })

  it('defaults to SHEET_FRAME_COUNT frames', () => {
    expect(sheetTimestamps(100)).toHaveLength(SHEET_FRAME_COUNT)
  })

  it('a single-frame request lands in the middle of the trimmed span', () => {
    expect(sheetTimestamps(100, 1)).toEqual([50])
  })

  it('returns [] for an invalid duration or count', () => {
    expect(sheetTimestamps(0, 10)).toEqual([])
    expect(sheetTimestamps(-5, 10)).toEqual([])
    expect(sheetTimestamps(NaN, 10)).toEqual([])
    expect(sheetTimestamps(100, 0)).toEqual([])
  })

  it('never produces a timestamp inside the trimmed 2% edges', () => {
    const duration = 600
    const times = sheetTimestamps(duration, 10)
    const trim = duration * 0.02
    expect(times[0]).toBeGreaterThanOrEqual(trim - 1e-9)
    expect(times[times.length - 1]).toBeLessThanOrEqual(duration - trim + 1e-9)
  })
})

describe('tileRect', () => {
  const meta = { cols: SHEET_COLS, rows: SHEET_ROWS, tileW: TILE_W, tileH: TILE_H }

  it('places tile 0 at the origin', () => {
    expect(tileRect(0, meta)).toEqual({ x: 0, y: 0, w: TILE_W, h: TILE_H })
  })

  it('advances columns left-to-right within a row', () => {
    expect(tileRect(1, meta)).toEqual({ x: TILE_W, y: 0, w: TILE_W, h: TILE_H })
    expect(tileRect(4, meta)).toEqual({ x: 4 * TILE_W, y: 0, w: TILE_W, h: TILE_H })
  })

  it('wraps to the next row after `cols` tiles', () => {
    expect(tileRect(5, meta)).toEqual({ x: 0, y: TILE_H, w: TILE_W, h: TILE_H })
    expect(tileRect(9, meta)).toEqual({ x: 4 * TILE_W, y: TILE_H, w: TILE_W, h: TILE_H })
  })
})

describe('coverCropRect', () => {
  it('is a no-op crop when source and dest share an aspect ratio', () => {
    expect(coverCropRect(1920, 1080, 320, 180)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 })
  })

  it('crops the sides of a wider-than-target source (e.g. ultrawide -> 16:9)', () => {
    const crop = coverCropRect(2400, 1000, 320, 180) // source ratio 2.4, dest 16:9 (~1.78)
    expect(crop.sh).toBe(1000)
    expect(crop.sw).toBeCloseTo(1000 * (320 / 180), 5)
    expect(crop.sx).toBeCloseTo((2400 - crop.sw) / 2, 5)
    expect(crop.sy).toBe(0)
  })

  it('crops the top/bottom of a taller-than-target source (e.g. portrait -> 16:9)', () => {
    const crop = coverCropRect(1080, 1920, 320, 180) // portrait source, landscape dest
    expect(crop.sw).toBe(1080)
    expect(crop.sh).toBeCloseTo(1080 / (320 / 180), 5)
    expect(crop.sy).toBeCloseTo((1920 - crop.sh) / 2, 5)
    expect(crop.sx).toBe(0)
  })

  it('degrades gracefully on invalid dimensions', () => {
    expect(coverCropRect(0, 1080, 320, 180)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 1080 })
    expect(coverCropRect(1920, 1080, 0, 180)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 })
  })
})

describe('captureFrameSheet (stall hardening — never rejects, never hangs)', () => {
  it('resolves { blob: null, meta: { tiles: [] } } when the video never fires any event', async () => {
    vi.useFakeTimers()
    const p = captureFrameSheet('blob:clip')
    await vi.advanceTimersByTimeAsync(SHEET_CAPTURE_STALL_MS + 1)
    await expect(p).resolves.toEqual({
      blob: null,
      meta: { cols: SHEET_COLS, rows: SHEET_ROWS, tileW: TILE_W, tileH: TILE_H, tiles: [] },
    })
  })

  it('resolves empty on a media error event', async () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    const p = captureFrameSheet('blob:clip')
    trap.get().dispatchEvent(new Event('error'))
    await expect(p).resolves.toEqual({
      blob: null,
      meta: { cols: SHEET_COLS, rows: SHEET_ROWS, tileW: TILE_W, tileH: TILE_H, tiles: [] },
    })
  })

  it('resolves empty when loadedmetadata reports an invalid duration', async () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    const p = captureFrameSheet('blob:clip')
    Object.defineProperty(trap.get(), 'duration', { value: NaN, configurable: true })
    trap.get().dispatchEvent(new Event('loadedmetadata'))
    await expect(p).resolves.toEqual({
      blob: null,
      meta: { cols: SHEET_COLS, rows: SHEET_ROWS, tileW: TILE_W, tileH: TILE_H, tiles: [] },
    })
  })

  it('sets crossOrigin=anonymous for a URL source', () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    void captureFrameSheet('https://bucket.example.com/signed/clip.mp4')
    expect(trap.get().crossOrigin).toBe('anonymous')
    vi.advanceTimersByTime(SHEET_CAPTURE_STALL_MS + 1)
  })

  it('does not set crossOrigin for a local File (same-origin blob URL)', () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    const file = new File(['bytes'], 'clip.mp4', { type: 'video/mp4' })
    void captureFrameSheet(file)
    expect(trap.get().crossOrigin).toBeNull()
    vi.advanceTimersByTime(SHEET_CAPTURE_STALL_MS + 1)
  })

  it('load progress re-arms the watchdog; only true inactivity trips it', async () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    let settled = false
    const p = captureFrameSheet('blob:clip').then((r) => {
      settled = true
      return r
    })

    await vi.advanceTimersByTimeAsync(SHEET_CAPTURE_STALL_MS - 1000)
    trap.get().dispatchEvent(new Event('progress'))
    await vi.advanceTimersByTimeAsync(SHEET_CAPTURE_STALL_MS - 1000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1001)
    await expect(p).resolves.toEqual({
      blob: null,
      meta: { cols: SHEET_COLS, rows: SHEET_ROWS, tileW: TILE_W, tileH: TILE_H, tiles: [] },
    })
    expect(settled).toBe(true)
  })
})
