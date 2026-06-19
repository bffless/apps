import { describe, it, expect, test } from 'vitest'
import {
  buildTranscriptGrid,
  cutColumns,
  formatClock,
  gridPosition,
  segmentsPerLine,
  windowLines,
  DEFAULT_SECONDS_PER_LINE,
  DEFAULT_SEGMENT_SECONDS,
  type TWord,
} from './transcriptGrid'

const w = (text: string, start: number, end = start + 0.2): TWord => ({ text, start, end })

describe('windowLines', () => {
  // A 0–200s grid at 5s/line → rows at 0,5,…,195.
  const grid = buildTranscriptGrid([], 5, 1, 200)

  it('keeps only the rows inside a scene window, on the absolute timeline', () => {
    // Scene 2 spans 1:44–3:00 → keep the row containing 104 (startSec 100) up to
    // but not including 180.
    const lines = windowLines(grid, 104, 180, 5)
    expect(lines[0].startSec).toBe(100)
    expect(lines[lines.length - 1].startSec).toBe(175)
    // Rows from earlier scenes are gone — switching tabs re-scopes the viewer.
    expect(lines.some((l) => l.startSec < 100)).toBe(false)
  })

  it('floors windowStart to its line so the row holding the scene start is kept', () => {
    const lines = windowLines(grid, 12, 25, 5)
    expect(lines[0].startSec).toBe(10) // the 10–15 row holds 0:12
  })

  it('defaults to the whole grid (no window)', () => {
    expect(windowLines(grid)).toEqual(grid)
  })
})

describe('buildTranscriptGrid minSeconds', () => {
  it('extends the grid past the last word to span minSeconds', () => {
    // One word at 0:01, but force the grid to cover 20s at 2s/line → 10 rows.
    const lines = buildTranscriptGrid([w('hi', 1)], 2, 0.25, 20)
    expect(lines.length).toBe(10)
    expect(lines[lines.length - 1].startSec).toBe(18)
  })

  it('does not shrink a grid that already runs longer than minSeconds', () => {
    const lines = buildTranscriptGrid([w('late', 40)], 2, 0.25, 10)
    expect(lines[lines.length - 1].startSec).toBe(40)
  })
})

describe('cutColumns', () => {
  it('flags the columns whose time slice overlaps a cut', () => {
    // row at 0s, 1s cells (5 cols over 5s); cut 2–4s covers cols 2 and 3.
    const cols = cutColumns(0, 5, 1, [{ start: 2, end: 4 }])
    expect(cols).toEqual([false, false, true, true, false])
  })

  it('maps cuts onto the right row by startSec', () => {
    // row starting at 10s; a 12–13s cut hits the 3rd cell (10,11,12,...).
    const cols = cutColumns(10, 5, 1, [{ start: 12, end: 13 }])
    expect(cols).toEqual([false, false, true, false, false])
  })

  it('returns all-false when there are no cuts', () => {
    expect(cutColumns(0, 4, 1, [])).toEqual([false, false, false, false])
  })

  it('flags exactly one column for a single grid-aligned segment', () => {
    // A one-cell grab builds its span as start = startSec + col*seg, end =
    // start + seg. The neighbouring cell's boundary is the same number reached
    // by different arithmetic (52 + 3*0.1 vs 52 + 2*0.1 + 0.1), off by ~1 ulp —
    // a strict overlap test bleeds the highlight onto the neighbour, so one
    // selected word reads as two.
    for (let col = 0; col < 20; col++) {
      const start = 52 + col * 0.1
      const flags = cutColumns(52, 20, 0.1, [{ start, end: start + 0.1 }])
      expect(flags.filter(Boolean), `col ${col}`).toHaveLength(1)
      expect(flags[col], `col ${col}`).toBe(true)
    }
  })
})

describe('segmentsPerLine', () => {
  it('divides the line into segment-wide cells', () => {
    expect(segmentsPerLine(5, 1)).toBe(5)
    expect(segmentsPerLine(5, 0.25)).toBe(20)
    expect(segmentsPerLine(10, 0.5)).toBe(20)
    expect(segmentsPerLine(3, 0.25)).toBe(12)
  })
  it('defaults to 2s / 0.1s = 20 cells and guards bad input', () => {
    expect(segmentsPerLine()).toBe(20)
    expect(segmentsPerLine(5, 0)).toBe(50) // falls back to the default 0.1s segment
  })
})

describe('buildTranscriptGrid — tenth-second cells (default)', () => {
  it('places each word in its tenth-second slice', () => {
    // rows are 2s -> 20 cells of 0.1s. Cell-midpoint starts dodge float-boundary
    // flooring (0.3/0.1 floors to 2): 0.1->col1, 0.35->col3, 1.65->col16; 4.95
    // lands in row 2 (4..6s) col 9, with the empty row 1 keeping the grid
    // continuous.
    const grid = buildTranscriptGrid([w('a', 0.1), w('b', 0.35), w('c', 1.65), w('d', 4.95)])
    expect(grid).toHaveLength(3)
    const { cells } = grid[0]
    expect(cells).toHaveLength(20)
    expect(cells[1].map((x) => x.text)).toEqual(['a'])
    expect(cells[3].map((x) => x.text)).toEqual(['b'])
    expect(cells[16].map((x) => x.text)).toEqual(['c'])
    expect(grid[2].cells[9].map((x) => x.text)).toEqual(['d'])
  })

  it('separates words that share a second but not a tenth', () => {
    // at 1s cells these would pile in one cell; at 0.1s they spread out
    const grid = buildTranscriptGrid([w('two', 6.0), w('words', 6.4), w('here', 6.9)])
    // second 6 is row 3 (6..8), within=0.0/0.4/0.9 -> cols 0, 4, 9
    expect(grid[3].cells[0].map((x) => x.text)).toEqual(['two'])
    expect(grid[3].cells[4].map((x) => x.text)).toEqual(['words'])
    expect(grid[3].cells[9].map((x) => x.text)).toEqual(['here'])
  })

  it('exposes the defaults', () => {
    expect(DEFAULT_SECONDS_PER_LINE).toBe(2)
    expect(DEFAULT_SEGMENT_SECONDS).toBe(0.1)
  })
})

describe('buildTranscriptGrid — configurable sizes', () => {
  it('supports one-second cells', () => {
    const grid = buildTranscriptGrid([w('a', 0.1), w('b', 1.9), w('c', 4.5)], 5, 1)
    expect(grid[0].cells).toHaveLength(5)
    expect(grid[0].cells[0].map((x) => x.text)).toEqual(['a'])
    expect(grid[0].cells[1].map((x) => x.text)).toEqual(['b'])
    expect(grid[0].cells[4].map((x) => x.text)).toEqual(['c'])
  })

  it('wraps to a new row every secondsPerLine seconds', () => {
    const grid = buildTranscriptGrid([w('r0', 2), w('r1', 5), w('r2', 10)], 5, 1)
    expect(grid).toHaveLength(3)
    expect(grid.map((l) => l.startSec)).toEqual([0, 5, 10])
    expect(grid[1].cells[0].map((x) => x.text)).toEqual(['r1'])
    expect(grid[2].cells[0].map((x) => x.text)).toEqual(['r2'])
  })

  it('keeps multiple words in the same slice, in input order', () => {
    const grid = buildTranscriptGrid([w('one', 6.05), w('two', 6.1), w('three', 6.2)], 5, 1)
    expect(grid[1].cells[1].map((x) => x.text)).toEqual(['one', 'two', 'three'])
  })

  it('emits empty rows for gaps so the grid stays continuous', () => {
    const grid = buildTranscriptGrid([w('start', 0), w('later', 12)], 5, 1)
    expect(grid).toHaveLength(3)
    expect(grid[1].cells.every((c) => c.length === 0)).toBe(true)
  })

  it('returns an empty grid for no words', () => {
    expect(buildTranscriptGrid([], 5, 0.25)).toEqual([])
  })

  it('clamps negative starts to 0 and a boundary word into the last cell', () => {
    const grid = buildTranscriptGrid([w('neg', -3), w('edge', 4.999)], 5, 1)
    expect(grid[0].cells[0].map((x) => x.text)).toEqual(['neg'])
    expect(grid[0].cells[4].map((x) => x.text)).toEqual(['edge'])
  })
})

describe('formatClock', () => {
  it('formats whole-second marks as m:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(5)).toBe('0:05')
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(600)).toBe('10:00')
  })
  it('floors and clamps', () => {
    expect(formatClock(9.9)).toBe('0:09')
    expect(formatClock(-4)).toBe('0:00')
  })
})

describe('gridPosition', () => {
  it('maps a time to its row + tenth-second column', () => {
    expect(gridPosition(0)).toEqual({ line: 0, col: 0 })
    expect(gridPosition(6.65)).toEqual({ line: 3, col: 6 }) // within=0.65 -> col 6
    expect(gridPosition(0.6, 5, 1)).toEqual({ line: 0, col: 0 })
    expect(gridPosition(6.6, 5, 1)).toEqual({ line: 1, col: 1 })
  })
  it('returns null before zero', () => {
    expect(gridPosition(-1)).toBeNull()
  })
})

test('buildTranscriptGrid preserves a word speaker tag', () => {
  const words: TWord[] = [{ text: 'hi', start: 0.1, end: 0.4, speaker: 'SPEAKER_00' }]
  const grid = buildTranscriptGrid(words, 2, 0.1)
  const cell = grid[0].cells.find((c) => c.length > 0)
  expect(cell?.[0].speaker).toBe('SPEAKER_00')
})
