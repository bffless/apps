import { describe, it, expect } from 'vitest'
import { buildFilmstrip, frameAt, frameForRow, spriteStyle, type FilmFrame } from './filmstrip'
import type { ContactSheet } from './frames'

/** A minimal contact sheet: a `cols`×N grid of `cellW`×`cellH` cells with a 2px
 *  gap, sampled at the given times. Geometry mirrors `composeContactSheet`. */
function sheet(times: number[], opts: Partial<ContactSheet> = {}): ContactSheet {
  const cols = opts.cols ?? 3
  const rows = Math.ceil(times.length / cols)
  const cellWidth = opts.cellWidth ?? 160
  const cellHeight = opts.cellHeight ?? 90
  const gap = opts.gap ?? 2
  return {
    dataUrl: '',
    url: 'http://sheet/x.png',
    width: cols * cellWidth + (cols + 1) * gap,
    height: rows * cellHeight + (rows + 1) * gap,
    cols,
    rows,
    cellWidth,
    cellHeight,
    gap,
    count: times.length,
    times,
    interval: 1,
    bytes: 0,
    index: 0,
    total: 1,
    ...opts,
  }
}

describe('buildFilmstrip', () => {
  it('flattens every cell into a time-sorted index', () => {
    const frames = buildFilmstrip([sheet([3, 4, 5]), sheet([0, 1, 2])])
    expect(frames.map((f) => f.time)).toEqual([0, 1, 2, 3, 4, 5])
    // index is the cell's position within ITS sheet, not the flattened order
    expect(frames[0].index).toBe(0)
    expect(frames[3].index).toBe(0) // first cell of the [3,4,5] sheet
  })

  it('skips sheets with no usable image', () => {
    const blank = sheet([9], { url: undefined, dataUrl: '' })
    const frames = buildFilmstrip([blank, sheet([1])])
    expect(frames).toHaveLength(1)
    expect(frames[0].time).toBe(1)
  })

  it('falls back to dataUrl when no bucket url yet', () => {
    const local = sheet([1], { url: undefined, dataUrl: 'data:image/png;base64,AA' })
    expect(buildFilmstrip([local])[0].url).toBe('data:image/png;base64,AA')
  })
})

describe('frameAt', () => {
  const frames = buildFilmstrip([sheet([0, 5, 10, 15])])

  it('returns null for an empty filmstrip', () => {
    expect(frameAt([], 3)).toBeNull()
  })

  it('clamps before the first / after the last frame', () => {
    expect(frameAt(frames, -2)?.time).toBe(0)
    expect(frameAt(frames, 99)?.time).toBe(15)
  })

  it('picks the nearest frame, rounding to the closer side', () => {
    expect(frameAt(frames, 6)?.time).toBe(5)
    expect(frameAt(frames, 8)?.time).toBe(10)
    expect(frameAt(frames, 7.5)?.time).toBe(5) // tie → earlier
  })
})

describe('frameForRow', () => {
  // Bucket-centred sampling (0.5, 1.5, …) — labels floor to 0:00, 0:01, …
  const frames = buildFilmstrip([sheet([0.5, 1.5, 2.5, 3.5, 4.5, 5.5])])

  it('returns null for an empty filmstrip', () => {
    expect(frameForRow([], 4)).toBeNull()
  })

  it('shows the frame whose whole second matches the row (label lines up)', () => {
    // The 0:04 row must show the 4.5s frame (labelled "0:04"), NOT the nearer 3.5s
    // ("0:03") that plain nearest-by-time tie-breaks to.
    expect(frameForRow(frames, 4)?.time).toBe(4.5)
    expect(frameForRow(frames, 6)?.time).toBe(5.5) // 0:06 has no frame → nearest 5.5
    expect(Math.floor(frameForRow(frames, 0)!.time)).toBe(0)
    expect(Math.floor(frameForRow(frames, 5)!.time)).toBe(5)
  })

  it('falls back to the nearest frame when this second has none', () => {
    const sparse = buildFilmstrip([sheet([2.5, 7.5])]) // ~5s apart
    expect(frameForRow(sparse, 4)?.time).toBe(2.5) // no frame in [4,5) → nearest
    expect(frameForRow(sparse, 2)?.time).toBe(2.5) // 2.5 ∈ [2,3) → matches
  })
})

describe('spriteStyle', () => {
  it('positions the cell by its row/col at full cell height (scale 1)', () => {
    // cell index 4 in a 3-col grid → col 1, row 1
    const f: FilmFrame = buildFilmstrip([sheet([0, 1, 2, 3, 4, 5])])[4]
    const style = spriteStyle(f, 160) // width == cellWidth → scale 1
    // x = gap + 1*(160+2) = 164 ; y = gap + 1*(90+2) = 94
    expect(style.backgroundPosition).toBe('-164px -94px')
    expect(style.width).toBe(160)
    expect(style.height).toBe(90) // FULL cell height — the gutter crops, not us
    expect(style.backgroundImage).toBe('url(http://sheet/x.png)')
  })

  it('scales the whole cell (and the sheet) to the requested width', () => {
    const f: FilmFrame = buildFilmstrip([sheet([0])])[0] // col 0, row 0
    const style = spriteStyle(f, 80) // scale 80/160 = 0.5
    // x = gap(2)+0 = 2 → round(2*0.5)=1 ; same for y
    expect(style.backgroundPosition).toBe('-1px -1px')
    expect(style.width).toBe(80)
    expect(style.height).toBe(45) // round(90 * 0.5)
  })

  it('derives cell geometry from width/height/cols/rows when the fields are absent', () => {
    // Sheets captured before cellWidth/cellHeight existed (rehydrated from
    // localStorage) only carry the pixel size + grid — derive, don't blank out.
    // Strip the explicit fields off a normal sheet, keeping its width/height/grid.
    const normal = sheet([0, 1, 2, 3, 4, 5]) // cellWidth 160 → width 488, height 186
    const stale = buildFilmstrip([{ ...normal, cellWidth: 0, cellHeight: 0, gap: 0 }])
    const style = spriteStyle(stale[4], 160) // index 4 → col 1, row 1; derives 160×90
    expect(style.backgroundPosition).toBe('-164px -94px')
    expect(style.height).toBe(90)
  })

  it('degrades to a plain box only when there is no geometry at all', () => {
    const normal = sheet([0])
    const f: FilmFrame = {
      time: 0,
      url: 'x',
      index: 0,
      sheet: { ...normal, cellWidth: 0, cellHeight: 0, cols: 0, width: 0 },
    }
    expect(spriteStyle(f, 100)).toEqual({ width: 100 })
  })
})
