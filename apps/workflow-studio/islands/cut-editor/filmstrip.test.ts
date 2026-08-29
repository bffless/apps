/**
 * The sprite geometry, against CE's real tiler (R143).
 *
 * `video/contact-sheet` runs CE's ffmpeg `frames` op, which composes each sheet with
 * `tile=${cols}x${rows}:padding=2:margin=2` — a 2 px border around the outside and 2 px
 * between adjacent cells. Every number below is computed by hand from THAT layout, not
 * from the code under test:
 *
 *     width  = cols * cellW + (cols - 1) * padding + 2 * margin
 *     height = rows * cellH + (rows - 1) * padding + 2 * margin
 *     cell (col,row) sits at (margin + col*(cellW+padding), margin + row*(cellH+padding))
 *
 * with `cellW × cellH = 320 × 180` (a 16:9 still at CE's default capture height).
 *
 * So a wrong `cols` on a short final sheet, or a gap that isn't 2, moves a crop onto
 * the neighbouring frame — which is invisible in a screenshot and wrong in exactly the
 * way a filmstrip is meant to be right.
 */
import { describe, expect, it } from 'vitest'
import { frameForRow, spriteStyle } from 'studio/lib/filmstrip'
import { framesFor, toContactSheet, type SheetImage } from './filmstrip'

const CELL_W = 320
const CELL_H = 180
const PAD = 2
const MARGIN = 2

/** The sheet pixel size ffmpeg emits for a `cols × rows` grid of 320×180 cells. */
const sheetWidth = (cols: number) => cols * CELL_W + (cols - 1) * PAD + 2 * MARGIN
const sheetHeight = (rows: number) => rows * CELL_H + (rows - 1) * PAD + 2 * MARGIN

/** Where ffmpeg drew cell `index` of a `cols`-wide sheet. */
const cellOrigin = (index: number, cols: number) => ({
  x: MARGIN + (index % cols) * (CELL_W + PAD),
  y: MARGIN + Math.floor(index / cols) * (CELL_H + PAD),
})

/** A full 12-cell sheet: 3 across, 4 down, sampled every 5 s. */
const full: SheetImage = {
  url: 'https://bucket.example/sheet-0.jpg',
  times: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55],
  width: sheetWidth(3), // 968
  height: sheetHeight(4), // 730
}

/** The short final sheet: 2 cells, laid out 2 WIDE (CE's `planSheets`), not 3. */
const short: SheetImage = {
  url: 'https://bucket.example/sheet-1.jpg',
  times: [60, 65],
  width: sheetWidth(2), // 646
  height: sheetHeight(1), // 184
}

describe('toContactSheet', () => {
  it('reconstructs a full sheet’s grid and cell size', () => {
    const sheet = toContactSheet(full, 0, 2)
    expect(sheet.width).toBe(968)
    expect(sheet.height).toBe(730)
    expect({ cols: sheet.cols, rows: sheet.rows }).toEqual({ cols: 3, rows: 4 })
    expect({ cellWidth: sheet.cellWidth, cellHeight: sheet.cellHeight, gap: sheet.gap }).toEqual({
      cellWidth: CELL_W,
      cellHeight: CELL_H,
      gap: PAD,
    })
    expect(sheet.url).toBe(full.url)
    expect(sheet.count).toBe(12)
    expect(sheet.interval).toBe(5)
  })

  it('lays a short final sheet out at its own narrower width', () => {
    const sheet = toContactSheet(short, 1, 2)
    expect({ cols: sheet.cols, rows: sheet.rows }).toEqual({ cols: 2, rows: 1 })
    expect({ cellWidth: sheet.cellWidth, cellHeight: sheet.cellHeight }).toEqual({
      cellWidth: CELL_W,
      cellHeight: CELL_H,
    })
  })
})

describe('spriteStyle over a reconstructed sheet', () => {
  const frames = framesFor([full, short])

  /** The style `CutEditor`'s gutter renders a frame with (`FILMSTRIP_WIDTH` = 150). */
  const styleAt = (time: number, width: number) => {
    const frame = frameForRow(frames, time)
    expect(frame).not.toBeNull()
    return { frame: frame!, style: spriteStyle(frame!, width) }
  }

  it('crops cell 0 of the first sheet at the sheet’s own scale', () => {
    // At width === cellWidth the scale is 1, so every number is the raw layout.
    const { frame, style } = styleAt(0, CELL_W)
    expect(frame.url).toBe(full.url)
    expect(frame.index).toBe(0)
    expect(style.backgroundImage).toBe(`url(${full.url})`)
    expect(style.backgroundSize).toBe('968px 730px')
    expect(style.backgroundPosition).toBe('-2px -2px')
    expect(style.height).toBe(CELL_H)
  })

  it('steps one padded cell to the right for cell 1', () => {
    const { frame, style } = styleAt(5, CELL_W)
    expect(frame.index).toBe(1)
    const { x, y } = cellOrigin(1, 3) // 324, 2
    expect(style.backgroundPosition).toBe(`-${x}px -${y}px`)
  })

  it('reaches the last cell of the bottom row', () => {
    const { frame, style } = styleAt(55, CELL_W)
    expect(frame.index).toBe(11)
    const { x, y } = cellOrigin(11, 3) // 646, 548
    expect(style.backgroundPosition).toBe(`-${x}px -${y}px`)
  })

  it('crops the short final sheet’s second cell from its OWN sheet', () => {
    const { frame, style } = styleAt(65, CELL_W)
    expect(frame.url).toBe(short.url)
    expect(frame.index).toBe(1)
    expect(style.backgroundSize).toBe('646px 184px')
    const { x, y } = cellOrigin(1, 2) // 324, 2 — 2 cols wide, not 3
    expect(style.backgroundPosition).toBe(`-${x}px -${y}px`)
  })

  it('scales the whole layout to the gutter width', () => {
    // The real case: 150 px of gutter for a 320 px cell — scale 0.46875, rounded.
    const scale = 150 / CELL_W
    const { style } = styleAt(55, 150)
    const { x, y } = cellOrigin(11, 3)
    expect(style.backgroundSize).toBe(
      `${Math.round(968 * scale)}px ${Math.round(730 * scale)}px`, // 454px 342px
    )
    expect(style.backgroundPosition).toBe(
      `-${Math.round(x * scale)}px -${Math.round(y * scale)}px`, // -303px -257px
    )
    expect(style.width).toBe(150)
    expect(style.height).toBe(Math.round(CELL_H * scale)) // 84 — the tall-row height
  })
})

describe('framesFor', () => {
  it('flattens both sheets into one time-sorted index, each cell keeping its sheet', () => {
    const frames = framesFor([full, short])
    expect(frames).toHaveLength(14)
    expect(frames.map((f) => f.time)).toEqual([...full.times, ...short.times])
    expect(frames[11].sheet.url).toBe(full.url)
    expect(frames[12].sheet.url).toBe(short.url)
    expect(frames[12].index).toBe(0) // index is within its OWN sheet, not global
  })

  it('picks the frame sampled in the row’s own second, else the nearest', () => {
    const frames = framesFor([full, short])
    expect(frameForRow(frames, 10)?.time).toBe(10)
    expect(frameForRow(frames, 12)?.time).toBe(10) // 2 s away vs 3 s to the next
    expect(frameForRow(frames, 14)?.time).toBe(15)
  })
})
