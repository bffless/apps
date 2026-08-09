import { describe, it, expect, vi, afterEach } from 'vitest'

const { presignedUploadMock } = vi.hoisted(() => ({ presignedUploadMock: vi.fn() }))
vi.mock('./upload', () => ({ presignedUpload: presignedUploadMock }))

import {
  tileCount,
  sheetTimestamps,
  chunkTimes,
  tileRect,
  coverCropRect,
  captureFrameSheets,
  uploadFrameSheets,
  MIN_TILES,
  MAX_TILES,
  TARGET_INTERVAL_SECONDS,
  SHEET_COLS,
  SHEET_ROWS,
  TILES_PER_SHEET,
  TILE_W,
  TILE_H,
  SHEET_CAPTURE_STALL_MS,
  type CaptureResult,
} from './frames'

/**
 * `captureFrameSheets` must never leave its promise unsettled — same
 * stall-hardening contract as Studio's `captureFramesAt`. jsdom never fires
 * real media/canvas events (`getContext('2d')` returns `null`, `toBlob`
 * never invokes its callback — verified against this repo's jsdom version),
 * which makes it exactly the pathological video these tests need; they only
 * exercise the video-event-driven paths, same as Studio's `frames.test.ts`.
 * The pure timestamp/geometry/packing math below is what's actually
 * asserted on pixel-accurate values.
 */

/** Intercept the <video> element captureFrameSheets creates so a test can
 *  fire media events on it. */
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
      if (!video) throw new Error('captureFrameSheets created no <video>')
      return video
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  presignedUploadMock.mockReset()
})

describe('tileCount', () => {
  it('targets one tile per TARGET_INTERVAL_SECONDS', () => {
    expect(tileCount(400)).toBe(Math.round(400 / TARGET_INTERVAL_SECONDS)) // 40
    expect(tileCount(840)).toBe(84) // 14 min -> ~85 per the brief, 84 exactly
  })

  it('clamps up to MIN_TILES for a short clip', () => {
    expect(tileCount(30)).toBe(MIN_TILES)
    expect(tileCount(1)).toBe(MIN_TILES)
  })

  it('clamps down to MAX_TILES for a very long clip', () => {
    expect(tileCount(10 * 3600)).toBe(MAX_TILES)
  })

  it('returns 0 for an invalid duration', () => {
    expect(tileCount(0)).toBe(0)
    expect(tileCount(-5)).toBe(0)
    expect(tileCount(NaN)).toBe(0)
  })
})

describe('sheetTimestamps', () => {
  it('spaces n points evenly, inclusive of the trimmed edges', () => {
    const times = sheetTimestamps(100, 10)
    expect(times).toHaveLength(10)
    expect(times[0]).toBeCloseTo(2, 5) // 2% of 100
    expect(times[9]).toBeCloseTo(98, 5) // 100 - 2%
    const gap = times[1] - times[0]
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(gap, 5)
    }
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
})

describe('chunkTimes', () => {
  it('splits into runs of at most size, last one short', () => {
    expect(chunkTimes([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunkTimes(Array.from({ length: 84 }, (_, i) => i), TILES_PER_SHEET).map((c) => c.length)).toEqual([
      30, 30, 24,
    ])
  })

  it('handles empty input', () => {
    expect(chunkTimes([], 30)).toEqual([])
  })
})

describe('tileRect', () => {
  const meta = { cols: SHEET_COLS, rows: SHEET_ROWS, tileW: TILE_W, tileH: TILE_H }

  it('places tile 0 at the origin', () => {
    expect(tileRect(0, meta)).toEqual({ x: 0, y: 0, w: TILE_W, h: TILE_H })
  })

  it('wraps to the next row after `cols` tiles (6x5 grid)', () => {
    expect(tileRect(6, meta)).toEqual({ x: 0, y: TILE_H, w: TILE_W, h: TILE_H })
    expect(tileRect(29, meta)).toEqual({ x: 5 * TILE_W, y: 4 * TILE_H, w: TILE_W, h: TILE_H })
  })
})

describe('coverCropRect', () => {
  it('is a no-op crop when source and dest share an aspect ratio', () => {
    expect(coverCropRect(1920, 1080, 320, 180)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 })
  })

  it('crops the sides of a wider-than-target source', () => {
    const crop = coverCropRect(2400, 1000, 320, 180)
    expect(crop.sh).toBe(1000)
    expect(crop.sw).toBeCloseTo(1000 * (320 / 180), 5)
  })

  it('degrades gracefully on invalid dimensions', () => {
    expect(coverCropRect(0, 1080, 320, 180)).toEqual({ sx: 0, sy: 0, sw: 0, sh: 1080 })
  })
})

describe('captureFrameSheets (stall hardening — never rejects, never hangs)', () => {
  it('resolves { sheets: [] } when the video never fires any event', async () => {
    vi.useFakeTimers()
    const p = captureFrameSheets('blob:clip')
    await vi.advanceTimersByTimeAsync(SHEET_CAPTURE_STALL_MS + 1)
    const result = await p
    expect(result.sheets).toEqual([])
    expect(result).toMatchObject({ tileW: TILE_W, tileH: TILE_H, cols: SHEET_COLS, rows: SHEET_ROWS })
  })

  it('resolves empty on a media error event', async () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    const p = captureFrameSheets('blob:clip')
    trap.get().dispatchEvent(new Event('error'))
    await expect(p).resolves.toMatchObject({ sheets: [] })
  })

  it('resolves empty when loadeddata reports an invalid duration', async () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    const p = captureFrameSheets('blob:clip')
    Object.defineProperty(trap.get(), 'duration', { value: NaN, configurable: true })
    trap.get().dispatchEvent(new Event('loadeddata'))
    await expect(p).resolves.toMatchObject({ sheets: [] })
  })

  it('sets crossOrigin=anonymous for a URL source', () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    void captureFrameSheets('https://bucket.example.com/signed/clip.mp4')
    expect(trap.get().crossOrigin).toBe('anonymous')
    vi.advanceTimersByTime(SHEET_CAPTURE_STALL_MS + 1)
  })

  it('does not set crossOrigin for a local File (same-origin blob URL)', () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    const file = new File(['bytes'], 'clip.mp4', { type: 'video/mp4' })
    void captureFrameSheets(file)
    expect(trap.get().crossOrigin).toBeNull()
    vi.advanceTimersByTime(SHEET_CAPTURE_STALL_MS + 1)
  })

  it('load progress re-arms the watchdog; only true inactivity trips it', async () => {
    vi.useFakeTimers()
    const trap = trapVideo()
    let settled = false
    const p = captureFrameSheets('blob:clip').then((r) => {
      settled = true
      return r
    })

    await vi.advanceTimersByTimeAsync(SHEET_CAPTURE_STALL_MS - 1000)
    trap.get().dispatchEvent(new Event('progress'))
    await vi.advanceTimersByTimeAsync(SHEET_CAPTURE_STALL_MS - 1000)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1001)
    await expect(p).resolves.toMatchObject({ sheets: [] })
    expect(settled).toBe(true)
  })
})

describe('uploadFrameSheets', () => {
  function captureResult(sheets: CaptureResult['sheets']): CaptureResult {
    return { tileW: TILE_W, tileH: TILE_H, cols: SHEET_COLS, rows: SHEET_ROWS, sheets }
  }

  it('returns null when there is nothing to upload', async () => {
    expect(await uploadFrameSheets(captureResult([]), 'v1')).toBeNull()
    expect(presignedUploadMock).not.toHaveBeenCalled()
  })

  it('skips sheets with no blob or no tiles', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const result = captureResult([
      { blob: null, tiles: [{ t: 1 }] },
      { blob, tiles: [] },
      { blob, tiles: [{ t: 2 }] },
    ])
    presignedUploadMock.mockResolvedValue('/api/uploads/sheets/v1/x.jpg')

    const out = await uploadFrameSheets(result, 'v1')

    expect(presignedUploadMock).toHaveBeenCalledTimes(1)
    expect(out).not.toBeNull()
  })

  it('uploads each sheet through /api/uploads/sheet, in order, and assembles v2 meta', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const result = captureResult([
      { blob, tiles: [{ t: 1 }, { t: 2 }] },
      { blob, tiles: [{ t: 31 }, { t: 32 }] },
    ])
    presignedUploadMock
      .mockResolvedValueOnce('/api/uploads/sheets/v1/sheet-0.jpg')
      .mockResolvedValueOnce('/api/uploads/sheets/v1/sheet-1.jpg')

    const out = await uploadFrameSheets(result, 'v1')

    expect(presignedUploadMock).toHaveBeenCalledTimes(2)
    expect(presignedUploadMock.mock.calls[0][1]).toBe('/api/uploads/sheet')
    expect(presignedUploadMock.mock.calls[0][2]).toBe('v1')

    expect(out).not.toBeNull()
    expect(out!.sheet_path).toBe('/api/uploads/sheets/v1/sheet-0.jpg') // first sheet, back-compat
    const meta = JSON.parse(out!.sheet_meta)
    expect(meta).toEqual({
      v: 2,
      tileW: TILE_W,
      tileH: TILE_H,
      cols: SHEET_COLS,
      rows: SHEET_ROWS,
      sheets: [
        { url: '/api/uploads/sheets/v1/sheet-0.jpg', tiles: [{ t: 1 }, { t: 2 }] },
        { url: '/api/uploads/sheets/v1/sheet-1.jpg', tiles: [{ t: 31 }, { t: 32 }] },
      ],
    })
  })
})
