import { describe, it, expect } from 'vitest'
import {
  nearestTile,
  spriteStyle,
  normalizeSheets,
  isSheetMetaV2,
  type SheetMetaV1,
  type SheetMetaV2,
} from './sprite'

const V1_META: SheetMetaV1 = {
  cols: 5,
  rows: 2,
  tileW: 320,
  tileH: 180,
  tiles: [
    { t: 0 },
    { t: 10 },
    { t: 20 },
    { t: 30 },
    { t: 40 },
    { t: 50 },
    { t: 60 },
    { t: 70 },
    { t: 80 },
    { t: 90 },
  ],
}

const V2_META: SheetMetaV2 = {
  v: 2,
  cols: 6,
  rows: 5,
  tileW: 320,
  tileH: 180,
  sheets: [
    {
      url: '/api/uploads/sheets/v1/sheet-0.jpg',
      tiles: Array.from({ length: 30 }, (_, i) => ({ t: i * 10 })),
    },
    {
      url: '/api/uploads/sheets/v1/sheet-1.jpg',
      tiles: Array.from({ length: 20 }, (_, i) => ({ t: 300 + i * 10 })),
    },
  ],
}

describe('isSheetMetaV2', () => {
  it('distinguishes v1 from v2', () => {
    expect(isSheetMetaV2(V1_META)).toBe(false)
    expect(isSheetMetaV2(V2_META)).toBe(true)
  })
})

describe('normalizeSheets', () => {
  it('wraps a v1 meta into one sheet, using the fallback url', () => {
    const sheets = normalizeSheets(V1_META, '/api/uploads/sheets/v1/x.jpg')
    expect(sheets).toEqual([{ url: '/api/uploads/sheets/v1/x.jpg', tiles: V1_META.tiles }])
  })

  it('a v1 meta with no fallback url normalizes to a null url', () => {
    expect(normalizeSheets(V1_META)).toEqual([{ url: null, tiles: V1_META.tiles }])
  })

  it('returns each v2 sheet as-is, ignoring the fallback url', () => {
    const sheets = normalizeSheets(V2_META, '/should/be/ignored.jpg')
    expect(sheets).toEqual(V2_META.sheets)
  })
})

describe('nearestTile', () => {
  it('v1: picks the exact match and reports sheetIndex 0', () => {
    expect(nearestTile(V1_META, 30, '/x.jpg')).toEqual({ sheetIndex: 0, tileIndex: 3, url: '/x.jpg' })
  })

  it('v1: picks the closer neighbor for an in-between value', () => {
    expect(nearestTile(V1_META, 32, '/x.jpg')).toEqual({ sheetIndex: 0, tileIndex: 3, url: '/x.jpg' })
    expect(nearestTile(V1_META, 38, '/x.jpg')).toEqual({ sheetIndex: 0, tileIndex: 4, url: '/x.jpg' })
  })

  it('v1: resolves an exact tie to the earlier tile', () => {
    expect(nearestTile(V1_META, 35, '/x.jpg')?.tileIndex).toBe(3)
  })

  it('v1: url is null with no fallback given', () => {
    expect(nearestTile(V1_META, 30)).toEqual({ sheetIndex: 0, tileIndex: 3, url: null })
  })

  it('v2: finds the nearest tile within the correct sheet, past the first sheet boundary', () => {
    // Sheet 0 covers t=0..290 (30 tiles, step 10); sheet 1 starts at t=300.
    expect(nearestTile(V2_META, 5)).toEqual({
      sheetIndex: 0,
      tileIndex: 0,
      url: '/api/uploads/sheets/v1/sheet-0.jpg',
    })
    expect(nearestTile(V2_META, 305)).toEqual({
      sheetIndex: 1,
      tileIndex: 0,
      url: '/api/uploads/sheets/v1/sheet-1.jpg',
    })
  })

  it('v2: a fallback url is ignored — each sheet carries its own', () => {
    const hit = nearestTile(V2_META, 5, '/should/be/ignored.jpg')
    expect(hit?.url).toBe('/api/uploads/sheets/v1/sheet-0.jpg')
  })

  it('clamps to the first/last tile beyond the sheet range', () => {
    expect(nearestTile(V1_META, -100, '/x.jpg')?.tileIndex).toBe(0)
    expect(nearestTile(V2_META, 10_000)?.sheetIndex).toBe(1)
  })

  it('returns null for missing/empty metadata', () => {
    expect(nearestTile(null, 30)).toBeNull()
    expect(nearestTile(undefined, 30)).toBeNull()
    expect(nearestTile({ ...V1_META, tiles: [] }, 30)).toBeNull()
  })
})

describe('spriteStyle', () => {
  it('scales the tile and sheet by displayW / tileW', () => {
    const style = spriteStyle(V1_META, 0, 112)
    expect(style).not.toBeNull()
    const scale = 112 / 320
    expect(style!.width).toBe(112)
    expect(style!.height).toBeCloseTo(180 * scale, 5)
    expect(style!.backgroundSize).toBe(`${5 * 320 * scale}px ${2 * 180 * scale}px`)
  })

  it('positions tile 0 at the sheet origin', () => {
    expect(spriteStyle(V1_META, 0, 320)!.backgroundPosition).toBe('0px 0px')
  })

  it('offsets background-position by -col*displayW / -row*displayH', () => {
    // Tile 6 -> col 1, row 1 (cols=5).
    expect(spriteStyle(V1_META, 6, 320)!.backgroundPosition).toBe('-320px -180px')
  })

  it('works off a v2 meta the same way (grid geometry is shared across sheets)', () => {
    // V2_META has cols=6 -> tileIndex 7 is col 1, row 1.
    expect(spriteStyle(V2_META, 7, 320)!.backgroundPosition).toBe('-320px -180px')
  })

  it('returns null for an invalid index or non-positive displayW', () => {
    expect(spriteStyle(V1_META, -1, 112)).toBeNull()
    expect(spriteStyle(V1_META, 0, 0)).toBeNull()
    expect(spriteStyle(V1_META, 0, -10)).toBeNull()
  })

  it('returns null for degenerate meta', () => {
    expect(spriteStyle({ ...V1_META, cols: 0 }, 0, 112)).toBeNull()
    expect(spriteStyle({ ...V1_META, tileW: 0 }, 0, 112)).toBeNull()
  })
})
