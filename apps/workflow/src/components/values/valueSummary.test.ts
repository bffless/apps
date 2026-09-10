/**
 * The two rules a folded pane rests on (2026-09-09 UX review): what a closed
 * row *says* the value is (`valueSummary`), and whether a value folds at all
 * (`isBulky`).
 *
 * Both matter more than they look. A row with no summary is a name and a type
 * and nothing to choose by, which is the pane the review complained about with
 * extra clicks. And a value that folds when its summary already prints the
 * whole of it shows the same text twice — once in the row, once in the body.
 */
import { describe, expect, it } from 'vitest'
import { isBulky, valueSummary } from './valueSummary'

/** `isFileRefLike`'s loose reading: path + name + url is what names a file. */
const fileRef = (extra: Record<string, unknown> = {}) => ({
  path: 'workflows/hello/talk/runs/r/show/0/play/clip.mp4',
  name: 'clip.mp4',
  url: 'https://example.test/clip.mp4',
  ...extra,
})

describe('valueSummary', () => {
  it('gives a file its type and size, and copes when it has neither', () => {
    expect(valueSummary(fileRef({ contentType: 'video/mp4', size: 281_700_000 }))).toBe(
      'video/mp4 · 268.7 MB',
    )
    expect(valueSummary(fileRef({ contentType: 'audio/wav' }))).toBe('audio/wav')
    expect(valueSummary(fileRef({ size: 2048 }))).toBe('2.0 KB')
    expect(valueSummary(fileRef())).toBeUndefined()
  })

  it('counts a list, groups the thousands, and says "files" when they all are', () => {
    expect(valueSummary(Array.from({ length: 8681 }, (_, i) => i))).toBe('8,681 items')
    expect(valueSummary([1])).toBe('1 item')
    expect(valueSummary([])).toBe('0 items')
    expect(valueSummary([fileRef(), fileRef()])).toBe('2 files')
    // One non-file and they are items again — "2 files" would be a lie.
    expect(valueSummary([fileRef(), 3])).toBe('2 items')
  })

  it('counts an object by its keys', () => {
    expect(valueSummary({ a: 1, b: 2, c: 3 })).toBe('3 keys')
    expect(valueSummary({ a: 1 })).toBe('1 key')
    expect(valueSummary({})).toBe('0 keys')
  })

  it('puts a string on one line, and cuts it at 80 characters', () => {
    expect(valueSummary('en')).toBe('en')
    // Newlines and runs of spaces collapse: a closed row is one line.
    expect(valueSummary("const line = 'hi'\nconsole.log(line)\n")).toBe("const line = 'hi' console.log(line)")
    const long = 'x'.repeat(200)
    expect(valueSummary(long)).toBe(`${'x'.repeat(80)}…`)
    // Whitespace-only is nothing worth saying.
    expect(valueSummary('   \n  ')).toBeUndefined()
  })

  it('prints a number or a boolean as itself', () => {
    expect(valueSummary(2918.543)).toBe('2918.543')
    expect(valueSummary(false)).toBe('false')
  })

  it('says nothing about an absent value', () => {
    expect(valueSummary(null)).toBeUndefined()
    expect(valueSummary(undefined)).toBeUndefined()
  })
})

describe('isBulky', () => {
  it('folds what has a body: files, lists, objects, tables, markdown, renderers', () => {
    expect(isBulky({ type: 'file' }, fileRef())).toBe(true)
    expect(isBulky({ type: 'json' }, [1, 2, 3])).toBe(true)
    expect(isBulky({ type: 'json' }, { a: 1 })).toBe(true)
    expect(isBulky({ type: 'table' }, [])).toBe(true)
    expect(isBulky({ type: 'markdown' }, '# hi')).toBe(true)
    expect(isBulky({ type: 'string', list: true }, ['a'])).toBe(true)
    for (const render of ['transcript', 'images', 'chart', 'code']) {
      expect(isBulky({ type: 'json', render }, [])).toBe(true)
    }
  })

  it('leaves a one-line value inline — the closed row would print it twice', () => {
    // The case the fold was nearly wrong about: a `form` step's own title.
    expect(isBulky({ type: 'string' }, 'Does the report look right?')).toBe(false)
    expect(isBulky({ type: 'string' }, 'en')).toBe(false)
    expect(isBulky({ type: 'number' }, 2918.543)).toBe(false)
    expect(isBulky({ type: 'boolean' }, true)).toBe(false)
    expect(isBulky({ type: 'string' }, null)).toBe(false)
  })

  it('folds a string once it stops being a one-liner', () => {
    expect(isBulky({ type: 'string' }, 'x'.repeat(81))).toBe(true)
    expect(isBulky({ type: 'string' }, 'two\nlines')).toBe(true)
  })

  it('never folds an island — a closed live surface is simply not there', () => {
    expect(isBulky({ type: 'json', render: 'island', src: 'viewer.html' }, { a: 1 })).toBe(false)
    expect(isBulky({ type: 'file', render: 'island', src: 'viewer.html' }, fileRef())).toBe(false)
  })
})
