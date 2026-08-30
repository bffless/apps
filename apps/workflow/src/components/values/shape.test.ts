/**
 * The shape rules (02 "Inferred shapes", apps#450), pinned one by one: what
 * the harness recognises by shape, what it recognises only when declared, and
 * — as important — what it leaves to the tree. Nothing here knows a scene from
 * a cut; the fixtures use those words only because the issue's run did.
 */
import { describe, expect, it } from 'vitest'
import type { FileRef } from '../../lib/runner/types'
import {
  LIST_PREVIEW,
  PATH_MIN_LENGTH,
  TABLE_MAX_COLUMNS,
  formatNumber,
  formatSeconds,
  hasShape,
  inferShape,
  isStoragePath,
  isTimeKey,
} from './shape'

const ref = (n: number): FileRef => ({
  path: `workflows/studio/long-to-short/runs/run_1/per-scene/${n}/assemble/clip.mp4`,
  name: `clip-${n}.mp4`,
  contentType: 'video/mp4',
  size: 100 + n,
  url: `/api/uploads/workflows/studio/long-to-short/runs/run_1/per-scene/${n}/assemble/clip.mp4`,
})

describe('formatNumber', () => {
  it('keeps integers, rounds fractions to two decimals, and never rounds a small fraction to 0', () => {
    expect(formatNumber(42)).toBe('42')
    expect(formatNumber(8.5)).toBe('8.5')
    expect(formatNumber(1.68166666)).toBe('1.68')
    expect(formatNumber(2.999)).toBe('3')
    expect(formatNumber(0.00123)).toBe('0.0012')
    expect(formatNumber(-0.004)).toBe('-0.0040')
    expect(formatNumber(NaN)).toBe('NaN')
  })
})

describe('formatSeconds', () => {
  it('spells seconds as m:ss.s, with hours only when there are any', () => {
    expect(formatSeconds(0)).toBe('0:00.0')
    expect(formatSeconds(8.52)).toBe('0:08.5')
    expect(formatSeconds(125.34)).toBe('2:05.3')
    expect(formatSeconds(3725.26)).toBe('1:02:05.3')
    expect(formatSeconds(59.97)).toBe('1:00.0')
  })

  it('leaves a negative or non-finite number as a plain number', () => {
    expect(formatSeconds(-1.5)).toBe('-1.5')
    expect(formatSeconds(Infinity)).toBe('Infinity')
  })
})

describe('isTimeKey', () => {
  it('reads start/end/duration/offset/time as the last word, in any casing', () => {
    for (const key of ['start', 'End', 'duration', 'offset', 'time', 'startTime', 'clip_end', 'scene-start', 'end_time']) {
      expect(isTimeKey(key), key).toBe(true)
    }
  })

  it('reads a seconds unit after another word, or `seconds` alone', () => {
    for (const key of ['start_s', 'durationSec', 'lengthSecs', 'seconds', 'total_seconds']) {
      expect(isTimeKey(key), key).toBe(true)
    }
  })

  it('leaves every other key alone — including a bare `s`, `ms`, and words that merely contain one', () => {
    for (const key of ['s', 'ms', 'endMs', 'started', 'timestamp', 'id', 'score', 'x', 'startIndex', '']) {
      expect(isTimeKey(key), key).toBe(false)
    }
  })
})

describe('isStoragePath', () => {
  const long = 'workflows/studio/long-to-short/runs/run_01M17/per-scene/0/assemble'

  it('takes a long slash-separated string with no whitespace and no scheme', () => {
    expect(long.length).toBeGreaterThanOrEqual(PATH_MIN_LENGTH)
    expect(isStoragePath(long)).toBe(true)
    expect(isStoragePath(`${long}/clip.mp4`)).toBe(true)
  })

  it('leaves short paths, sentences, urls and root-relative paths to the chip', () => {
    expect(isStoragePath('video/frames')).toBe(false)
    expect(isStoragePath('a/b/c')).toBe(false)
    expect(isStoragePath('a sentence / with slashes / and spaces in it, quite long')).toBe(false)
    expect(isStoragePath('https://example.com/a/b/c/d/e/f/g/h/i/j/k/l')).toBe(false)
    expect(isStoragePath('/api/uploads/workflows/studio/long-to-short/x.mp4')).toBe(false)
    expect(isStoragePath('workflows//studio/long-to-short/runs/run_01M17/x')).toBe(false)
  })
})

describe('inferShape', () => {
  it('reads homogeneous flat rows as a table, columns in the first row’s order', () => {
    const shape = inferShape([
      { start: 8.52, end: 10.48 },
      { end: 14, start: 12.1 },
      { start: 20, end: null },
    ])
    expect(shape).toMatchObject({ kind: 'table', columns: [{ key: 'start' }, { key: 'end' }] })
  })

  it('leaves ragged rows, wide rows, nested values and non-object items to the tree', () => {
    expect(inferShape([{ a: 1 }, { a: 1, b: 2 }])).toBeNull()
    expect(inferShape([{ a: 1 }, { b: 1 }])).toBeNull()
    expect(inferShape([{ a: { nested: true } }])).toBeNull()
    expect(inferShape([{ a: [1] }])).toBeNull()
    expect(inferShape([{ a: 'x'.repeat(121) }])).toBeNull()
    expect(inferShape([{ a: 1 }, 'nope'])).toBeNull()
    expect(inferShape([{}])).toBeNull()
    const wide = Object.fromEntries(Array.from({ length: TABLE_MAX_COLUMNS + 1 }, (_, i) => [`c${i}`, i]))
    expect(inferShape([wide])).toBeNull()
    const justRight = Object.fromEntries(Array.from({ length: TABLE_MAX_COLUMNS }, (_, i) => [`c${i}`, i]))
    expect(inferShape([justRight])).toMatchObject({ kind: 'table' })
  })

  it('reads an array of numbers, or of short strings, as a list — and a mixed one as nothing', () => {
    expect(inferShape([1.68, 5.03, 8.39])).toEqual({ kind: 'list', items: [1.68, 5.03, 8.39] })
    expect(inferShape(['a', 'b'])).toEqual({ kind: 'list', items: ['a', 'b'] })
    expect(inferShape([1, 'a'])).toBeNull()
    expect(inferShape(['a', 'two\nlines'])).toBeNull()
    expect(inferShape([true, false])).toBeNull()
    expect(inferShape([])).toBeNull()
  })

  it('reads the harness’s own File-ref shape, alone or as a whole array', () => {
    expect(inferShape(ref(0))).toEqual({ kind: 'file', ref: ref(0) })
    expect(inferShape([ref(0), ref(1)])).toEqual({ kind: 'files', refs: [ref(0), ref(1)] })
    expect(inferShape([ref(0), { start: 1, end: 2 }])).toBeNull()
  })

  it('reads a long storage path as a path, and any other string as nothing', () => {
    const path = 'workflows/studio/long-to-short/runs/run_01M17/per-scene/0/assemble'
    expect(inferShape(path)).toEqual({ kind: 'path', path })
    expect(inferShape('hello')).toBeNull()
    expect(inferShape(42)).toBeNull()
    expect(inferShape(null)).toBeNull()
    expect(inferShape({ a: 1 })).toBeNull()
  })

  describe('declared formats win, and are lenient', () => {
    it('format: table takes the declared columns, else the union of every row’s keys', () => {
      const rows = [{ a: 1 }, { b: 2, c: { deep: true } }]
      expect(inferShape(rows, { format: 'table' })).toEqual({
        kind: 'table',
        columns: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
        rows,
      })
      expect(inferShape(rows, { format: 'table', columns: ['b', { key: 'a', label: 'A' }, { nope: 1 }] })).toEqual({
        kind: 'table',
        columns: [{ key: 'b' }, { key: 'a', label: 'A' }],
        rows,
      })
      expect(inferShape([1, 2], { format: 'table' })).toBeNull()
    })

    it('format: list takes any array of scalars, mixed kinds included', () => {
      expect(inferShape([1, 'a', true, null], { format: 'list' })).toEqual({ kind: 'list', items: [1, 'a', true, null] })
      expect(inferShape([{ a: 1 }], { format: 'list' })).toBeNull()
    })

    it('format: path takes a string of any length', () => {
      expect(inferShape('out/x.mp4', { format: 'path' })).toEqual({ kind: 'path', path: 'out/x.mp4' })
    })

    it('a File ref is a file whatever the format says', () => {
      expect(inferShape([ref(0)], { format: 'table' })).toEqual({ kind: 'files', refs: [ref(0)] })
    })
  })
})

describe('hasShape', () => {
  it('is true for a shaped value, or for one holding a shaped value anywhere inside', () => {
    expect(hasShape([{ start: 1, end: 2 }])).toBe(true)
    expect(hasShape({ body: { times: [1, 2, 3] } })).toBe(true)
    expect(hasShape({ needs: { clips: [ref(0)] } })).toBe(true)
    expect(hasShape({ source: 'workflows/studio/long-to-short/runs/run_01M17/x.mov' })).toBe(true)
  })

  it('is false for a value the tree would draw exactly as today', () => {
    expect(hasShape({ a: 1, b: 'two', c: true })).toBe(false)
    expect(hasShape([1, 'a'])).toBe(false)
    expect(hasShape({ a: { b: { c: [] } } })).toBe(false)
    expect(hasShape('short')).toBe(false)
    expect(hasShape(null)).toBe(false)
  })

  it('stops at the tree’s own depth', () => {
    let deep: unknown = [1, 2, 3]
    for (let i = 0; i < 7; i++) deep = { deeper: deep }
    expect(hasShape(deep)).toBe(false)
    let near: unknown = [1, 2, 3]
    for (let i = 0; i < 5; i++) near = { deeper: near }
    expect(hasShape(near)).toBe(true)
  })

  it('previews exactly LIST_PREVIEW items inline', () => {
    expect(LIST_PREVIEW).toBe(12)
  })
})
