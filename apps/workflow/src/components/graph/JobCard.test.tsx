/**
 * `matrixItemLabel` (08): hello's matrix items are plain strings, but the
 * Studio port's (`per-scene`) are objects (`{ number, title, source, ... }`) —
 * a naive `String(value)` on one of those renders `[object Object]` wherever an
 * item is named.
 *
 * The job card no longer names items at all (spec 2026-09-08, Task 8: the
 * graph draws one node per job and the run rail owns the matrix items), so the
 * label is pinned here as the pure function every namer shares. What renders it
 * now — the rail, and the job page's row badges — pins it through their own
 * screens.
 */
import { describe, expect, it } from 'vitest'
import { itemLabel, matrixItemLabel } from './geometry'

describe('matrixItemLabel', () => {
  it('returns a string or number value as itself', () => {
    expect(matrixItemLabel('World', 0)).toBe('World')
    expect(matrixItemLabel(3, 0)).toBe('3')
  })

  it("reads an object's title/name/label/id instead of `[object Object]`", () => {
    expect(matrixItemLabel({ number: 3, title: 'Intro', source: 'a.mp4' }, 0)).toBe('Intro')
    expect(matrixItemLabel({ id: 'scene-3' }, 0)).toBe('scene-3')
  })

  it('falls back to its position when nothing on the object reads as a name', () => {
    expect(matrixItemLabel({ number: 3 }, 2)).toBe('#3')
  })

  it("uses a File ref's own name", () => {
    const fileRef = { path: 'x/y.mov', name: 'take.mov', url: '/api/uploads/x/y.mov' }
    expect(matrixItemLabel(fileRef, 0)).toBe('take.mov')
  })
})

describe('itemLabel', () => {
  it('names every binding of one item, never `[object Object]`', () => {
    const label = itemLabel({ scene: { number: 1, title: 'Intro', source: 'a.mp4' } }, 0)

    expect(label).toBe('scene: Intro')
    expect(label).not.toContain('[object Object]')
  })

  it('falls back to the item’s position when it binds nothing', () => {
    expect(itemLabel({}, 1)).toBe('Item 2')
  })
})
