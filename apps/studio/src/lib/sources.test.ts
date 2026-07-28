import { describe, it, expect } from 'vitest'
import { sourceOffsets, totalDuration, globalToLocal, localToGlobal, sourceForScene, previewSourceFor } from './sources'

const SOURCES = [
  { id: 'a', duration: 100 },
  { id: 'b', duration: 50 },
  { id: 'c', duration: 200 },
]

describe('sources timeline math', () => {
  it('totalDuration sums durations', () => {
    expect(totalDuration(SOURCES)).toBe(350)
    expect(totalDuration([])).toBe(0)
  })

  it('sourceOffsets places each source after the previous', () => {
    expect(sourceOffsets(SOURCES)).toEqual([
      { id: 'a', start: 0, end: 100 },
      { id: 'b', start: 100, end: 150 },
      { id: 'c', start: 150, end: 350 },
    ])
  })

  it('globalToLocal routes a global second to (sourceId, localTime)', () => {
    expect(globalToLocal(SOURCES, 0)).toEqual({ sourceId: 'a', localTime: 0 })
    expect(globalToLocal(SOURCES, 120)).toEqual({ sourceId: 'b', localTime: 20 })
    expect(globalToLocal(SOURCES, 349)).toEqual({ sourceId: 'c', localTime: 199 })
  })

  it('globalToLocal clamps a boundary instant to the source it ends, and out-of-range to the last', () => {
    expect(globalToLocal(SOURCES, 100)).toEqual({ sourceId: 'b', localTime: 0 })
    expect(globalToLocal(SOURCES, 350)).toEqual({ sourceId: 'c', localTime: 200 })
    expect(globalToLocal(SOURCES, 999)).toEqual({ sourceId: 'c', localTime: 200 })
  })

  it('globalToLocal returns null for no sources', () => {
    expect(globalToLocal([], 5)).toBeNull()
  })

  it('localToGlobal is the inverse', () => {
    expect(localToGlobal(SOURCES, 'b', 20)).toBe(120)
    expect(localToGlobal(SOURCES, 'a', 0)).toBe(0)
    expect(localToGlobal(SOURCES, 'missing', 5)).toBeNull()
  })
})

it('finds the VideoSource a scene belongs to', () => {
  const sources = [{ id: 'a', duration: 1 }, { id: 'b', duration: 1 }]
  expect(sourceForScene(sources, { sourceId: 'b' })?.id).toBe('b')
  expect(sourceForScene(sources, { sourceId: 'z' })).toBeNull()
})

describe('previewSourceFor', () => {
  // The shape that broke in the field: two imported files, chapters 1-3 on the
  // first and 4-6 on the second, each chapter timed in ITS source's local
  // seconds — so scene 4 starts at 0 on the second video, exactly where scene 1
  // starts on the first.
  const SOURCES = [
    { id: 's1', fileName: 'first.mp4', sourceUrl: '/api/uploads/first.mp4' },
    { id: 's2', fileName: 'second.mp4', sourceUrl: '/api/uploads/second.mp4' },
  ]
  const LEGACY = '/api/uploads/first.mp4' // project.sourceUrl mirrors source[0]

  it('plays the SECOND file for a chapter that belongs to it', () => {
    expect(previewSourceFor(SOURCES, { sourceId: 's2' }, LEGACY)).toEqual({
      url: '/api/uploads/second.mp4',
      fileName: 'second.mp4',
    })
  })

  it('still plays the first file for a chapter that belongs to it', () => {
    expect(previewSourceFor(SOURCES, { sourceId: 's1' }, LEGACY).url).toBe('/api/uploads/first.mp4')
  })

  it('falls back to the legacy top-level url with no scene or no sources', () => {
    expect(previewSourceFor(SOURCES, null, LEGACY)).toEqual({ url: LEGACY, fileName: null })
    expect(previewSourceFor([], { sourceId: 's2' }, LEGACY)).toEqual({ url: LEGACY, fileName: null })
  })

  it('falls back when the scene points at a source that is gone', () => {
    expect(previewSourceFor(SOURCES, { sourceId: 'deleted' }, LEGACY).url).toBe(LEGACY)
  })

  it('falls back when the matched source has no uploaded url yet', () => {
    const pending = [{ id: 's2', fileName: 'second.mp4', sourceUrl: null }]
    expect(previewSourceFor(pending, { sourceId: 's2' }, LEGACY)).toEqual({
      url: LEGACY,
      fileName: 'second.mp4',
    })
  })
})
