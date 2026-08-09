import { describe, it, expect } from 'vitest'
import { nearestTileIndex, spriteStyle, type SheetMeta } from './sprite'

const META: SheetMeta = {
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

describe('nearestTileIndex', () => {
  it('picks the exact match', () => {
    expect(nearestTileIndex(META, 30)).toBe(3)
  })

  it('picks the closer neighbor for an in-between value', () => {
    expect(nearestTileIndex(META, 32)).toBe(3)
    expect(nearestTileIndex(META, 38)).toBe(4)
  })

  it('resolves an exact tie to the earlier tile', () => {
    expect(nearestTileIndex(META, 35)).toBe(3)
  })

  it('clamps to the first/last tile beyond the sheet range', () => {
    expect(nearestTileIndex(META, -100)).toBe(0)
    expect(nearestTileIndex(META, 10_000)).toBe(9)
  })

  it('returns -1 for missing/empty tiles', () => {
    expect(nearestTileIndex(null, 30)).toBe(-1)
    expect(nearestTileIndex(undefined, 30)).toBe(-1)
    expect(nearestTileIndex({ ...META, tiles: [] }, 30)).toBe(-1)
  })
})

describe('spriteStyle', () => {
  it('scales the tile and sheet by displayW / tileW', () => {
    const style = spriteStyle(META, 0, 112)
    expect(style).not.toBeNull()
    const scale = 112 / 320
    expect(style!.width).toBe(112)
    expect(style!.height).toBeCloseTo(180 * scale, 5)
    expect(style!.backgroundSize).toBe(`${5 * 320 * scale}px ${2 * 180 * scale}px`)
  })

  it('positions tile 0 at the sheet origin', () => {
    const style = spriteStyle(META, 0, 320)
    expect(style!.backgroundPosition).toBe('0px 0px')
  })

  it('offsets background-position by -col*displayW / -row*displayH', () => {
    // Tile 6 -> col 1, row 1 (cols=5).
    const style = spriteStyle(META, 6, 320)
    expect(style!.backgroundPosition).toBe('-320px -180px')
  })

  it('offsets correctly at a scaled-down display size', () => {
    const style = spriteStyle(META, 4, 112) // col 4, row 0
    const scale = 112 / 320
    const expectedX = -(4 * 112)
    expect(style!.backgroundPosition).toBe(`${expectedX}px 0px`)
    void scale
  })

  it('returns null for an invalid index or non-positive displayW', () => {
    expect(spriteStyle(META, -1, 112)).toBeNull()
    expect(spriteStyle(META, 0, 0)).toBeNull()
    expect(spriteStyle(META, 0, -10)).toBeNull()
  })

  it('returns null for degenerate meta', () => {
    expect(spriteStyle({ ...META, cols: 0 }, 0, 112)).toBeNull()
    expect(spriteStyle({ ...META, tileW: 0 }, 0, 112)).toBeNull()
  })
})
