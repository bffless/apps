import { describe, it, expect } from 'vitest'
import { sourceOffsets, totalDuration, globalToLocal, localToGlobal, sourceForScene } from './sources'

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
