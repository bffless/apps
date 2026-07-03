import { describe, it, expect } from 'vitest'
import { sourceTimeAt, outputTimeAt, nextKeptSource } from './preview'
import type { AssemblePlan } from './assemble'

// Scene [100, 160] with a 120–130 cut → clip-local kept pieces 0–20 and 30–60.
const plan: AssemblePlan = {
  video: [
    { start: 0, end: 20 },
    { start: 30, end: 60 },
  ],
  duration: 50,
}
const SCENE_START = 100

describe('sourceTimeAt', () => {
  it('maps output time inside the first piece 1:1 (plus the scene offset)', () => {
    expect(sourceTimeAt(plan, 0, SCENE_START)).toBe(100)
    expect(sourceTimeAt(plan, 12, SCENE_START)).toBe(112)
  })

  it('jumps the cut: output seconds after piece 1 land in piece 2', () => {
    expect(sourceTimeAt(plan, 20, SCENE_START)).toBe(120) // boundary → piece 1 end
    expect(sourceTimeAt(plan, 25, SCENE_START)).toBe(135) // 5s into piece 2 (30+5)
  })

  it('clamps to the plan bounds', () => {
    expect(sourceTimeAt(plan, -3, SCENE_START)).toBe(100)
    expect(sourceTimeAt(plan, 999, SCENE_START)).toBe(160)
  })

  it('returns sceneStart for an all-cut plan', () => {
    expect(sourceTimeAt({ video: [], duration: 0 }, 5, SCENE_START)).toBe(SCENE_START)
  })
})

describe('outputTimeAt', () => {
  it('is the inverse of sourceTimeAt on kept footage', () => {
    expect(outputTimeAt(plan, 112, SCENE_START)).toBe(12)
    expect(outputTimeAt(plan, 135, SCENE_START)).toBe(25)
  })

  it('maps a source second inside a cut to where the cut collapses', () => {
    expect(outputTimeAt(plan, 125, SCENE_START)).toBe(20)
  })

  it('clamps before the first piece and past the last', () => {
    expect(outputTimeAt(plan, 90, SCENE_START)).toBe(0)
    expect(outputTimeAt(plan, 200, SCENE_START)).toBe(50)
  })
})

describe('nextKeptSource', () => {
  it('returns null while inside kept footage', () => {
    expect(nextKeptSource(plan, 110, SCENE_START)).toBeNull()
    expect(nextKeptSource(plan, 140, SCENE_START)).toBeNull()
  })

  it('returns the next kept start when inside a cut', () => {
    expect(nextKeptSource(plan, 125, SCENE_START)).toBe(130)
  })

  it('returns the first kept start before the scene begins', () => {
    expect(nextKeptSource(plan, 95, SCENE_START)).toBe(100)
  })

  it('returns Infinity past the last kept span (the stop signal)', () => {
    expect(nextKeptSource(plan, 161, SCENE_START)).toBe(Infinity)
  })
})
