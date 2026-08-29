/**
 * `keep` — the one number the rest of the workflow depends on. `assemble` re-slices
 * the SCENE CLIP with these spans, so an off-by-`scene.start` here silently ships a
 * short cut from the wrong part of the recording.
 */
import { describe, expect, it } from 'vitest'
import { keepForClip } from './keep'

const scene = { start: 0, end: 30 }

describe('keepForClip', () => {
  it('keeps the whole scene when nothing is cut', () => {
    expect(keepForClip([], scene)).toEqual([{ start: 0, end: 30 }])
  })

  it('is the complement of the cuts inside the scene window', () => {
    expect(keepForClip([{ start: 10, end: 12 }], scene)).toEqual([
      { start: 0, end: 10 },
      { start: 12, end: 30 },
    ])
  })

  it('shifts every span into clip time', () => {
    expect(keepForClip([{ start: 110, end: 112 }], { start: 100, end: 130 })).toEqual([
      { start: 0, end: 10 },
      { start: 12, end: 30 },
    ])
  })

  it('merges overlapping and touching cuts before complementing', () => {
    expect(
      keepForClip(
        [
          { start: 12, end: 15 },
          { start: 10, end: 13 },
        ],
        scene,
      ),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 15, end: 30 },
    ])
  })

  it('drops a zero-length keep when a cut runs to the scene edge', () => {
    expect(keepForClip([{ start: 0, end: 10 }], scene)).toEqual([{ start: 10, end: 30 }])
    expect(keepForClip([{ start: 20, end: 30 }], scene)).toEqual([{ start: 0, end: 20 }])
  })

  it('clamps cuts that overhang the scene', () => {
    expect(keepForClip([{ start: 95, end: 110 }], { start: 100, end: 130 })).toEqual([
      { start: 10, end: 30 },
    ])
  })

  it('keeps nothing when the whole scene is cut', () => {
    expect(keepForClip([{ start: 0, end: 30 }], scene)).toEqual([])
  })
})
