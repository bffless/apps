import { describe, it, expect } from 'vitest'
import {
  SERVER_SHEET_GAP,
  toServerSheets,
  toServerFrames,
  sheetLabels,
  toContactSheets,
  restampSheets,
} from './serverFrames'

const rawSheets = {
  sheets: [
    { url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-01.jpg', times: [1, 2, 3, 4], cols: 3, rows: 2, index: 0, total: 2, bytes: 1200 },
    { url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-02.jpg', times: [5], cols: 1, rows: 1, index: 1, total: 2, bytes: 300 },
  ],
  drawn: true,
}

describe('toServerSheets', () => {
  it('keeps url, times, grid and bytes', () => {
    expect(toServerSheets(rawSheets)).toEqual([
      { url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-01.jpg', times: [1, 2, 3, 4], cols: 3, rows: 2, bytes: 1200 },
      { url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-02.jpg', times: [5], cols: 1, rows: 1, bytes: 300 },
    ])
  })
  it('accepts the job row result as a JSON string', () => {
    expect(toServerSheets(JSON.stringify(rawSheets))).toHaveLength(2)
  })
  it('throws when the job came back without sheets', () => {
    expect(() => toServerSheets({ sheets: [] })).toThrow('The contact-sheet job finished without any sheets.')
    expect(() => toServerSheets(null)).toThrow('The contact-sheet job finished without any sheets.')
  })
})

describe('toServerFrames', () => {
  it('keeps time and url in order, dropping entries without a url', () => {
    expect(
      toServerFrames({ frames: [{ time: 10, url: '/api/uploads/a.jpg' }, { time: 11 }, { time: 12, url: '/api/uploads/b.jpg' }] }),
    ).toEqual([
      { time: 10, url: '/api/uploads/a.jpg' },
      { time: 12, url: '/api/uploads/b.jpg' },
    ])
  })
  it('throws when there are no frames', () => {
    expect(() => toServerFrames({ frames: [] })).toThrow('The frame job finished without any frames.')
  })
})

describe('sheetLabels', () => {
  it('uses the burned-in clock format', () => {
    expect(sheetLabels([5.9, 65, 3725])).toEqual(['0:05', '1:05', '1:02:05'])
  })
})

describe('toContactSheets', () => {
  it('derives cell geometry from the image size and stamps each still with its own display time', () => {
    const got = toContactSheets(
      toServerSheets(rawSheets),
      [
        { width: 3 * 1280 + 4 * SERVER_SHEET_GAP, height: 2 * 720 + 3 * SERVER_SHEET_GAP },
        { width: 1280 + 2 * SERVER_SHEET_GAP, height: 720 + 2 * SERVER_SHEET_GAP },
      ],
      (t) => t + 100,
      1,
    )
    expect(got[0]).toEqual({
      dataUrl: '',
      url: '/api/uploads/projects/p1/thumbnails/server/u/sheet-01.jpg',
      width: 3848,
      height: 1446,
      cols: 3,
      rows: 2,
      cellWidth: 1280,
      cellHeight: 720,
      gap: 2,
      count: 4,
      times: [101, 102, 103, 104],
      interval: 1,
      bytes: 1200,
      index: 0,
      total: 2,
    })
    expect(got[1].times).toEqual([105])
    expect(got[1].cellWidth).toBe(1280)
  })
  it('matches display times by time, so a gap between sheets never shifts later sheets', () => {
    // Asked for 1-4 and 7-10; the server dropped 7 and 8. Positional slicing would
    // have stamped the second sheet with the display times of 7 and 8.
    const display = new Map([[1, 61], [2, 62], [3, 63], [4, 64], [7, 67], [8, 68], [9, 69], [10, 70]])
    const got = toContactSheets(
      toServerSheets({
        sheets: [
          { url: '/a.jpg', times: [1, 2, 3, 4], cols: 3, rows: 2, bytes: 1 },
          { url: '/b.jpg', times: [9, 10], cols: 2, rows: 1, bytes: 1 },
        ],
      }),
      [],
      (t) => display.get(t) ?? t,
      1,
    )
    expect(got.map((s) => s.times)).toEqual([[61, 62, 63, 64], [69, 70]])
    expect(got.map((s) => s.count)).toEqual([4, 2])
  })
  it('leaves geometry at 0 when the image size is unknown', () => {
    const [s] = toContactSheets(toServerSheets(rawSheets), [{ width: 0, height: 0 }], (t) => t, 1)
    expect(s.cellWidth).toBe(0)
    expect(s.cellHeight).toBe(0)
  })
})

describe('restampSheets', () => {
  it('numbers sheets across the combined list', () => {
    const a = toContactSheets(toServerSheets(rawSheets), [], (t) => t, 1)
    const b = toContactSheets(toServerSheets(rawSheets), [], (t) => t + 5, 1)
    expect(restampSheets([...a, ...b]).map((s) => [s.index, s.total])).toEqual([[0, 4], [1, 4], [2, 4], [3, 4]])
  })
})
