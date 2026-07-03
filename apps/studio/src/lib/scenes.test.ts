import { describe, it, expect } from 'vitest'
import { buildScenes, wordCount, sceneVideoSeconds, WORDS_PER_SECOND } from './scenes'

describe('wordCount', () => {
  it('counts words', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('  one   two three ')).toBe(3)
  })
})

describe('buildScenes', () => {
  it('returns one scene for a short clip', () => {
    const scenes = buildScenes(30)
    expect(scenes).toHaveLength(1)
    expect(scenes[0]).toMatchObject({ start: 0, end: 30, status: 'pending' })
  })

  it('breaks a long talk into several ~3.5 min scenes covering the whole clip', () => {
    const duration = 45 * 60
    const scenes = buildScenes(duration)
    expect(scenes.length).toBeGreaterThan(1)
    expect(scenes[0].start).toBe(0)
    expect(scenes[scenes.length - 1].end).toBeCloseTo(duration, 5)
    // contiguous, no gaps
    for (let i = 1; i < scenes.length; i++) {
      expect(scenes[i].start).toBeCloseTo(scenes[i - 1].end, 5)
    }
  })

  it('carries the full-span transcript and a default refine prompt', () => {
    const [scene] = buildScenes(120)
    // full-span transcript ≈ footage length at the speaking rate
    expect(wordCount(scene.transcript) / WORDS_PER_SECOND).toBeCloseTo(sceneVideoSeconds(scene), 0)
    expect(scene.refinePrompt).toBeTruthy()
    expect(typeof scene.refinePrompt).toBe('string')
  })

  it('buildScenes stamps every scene with a sourceId', () => {
    const scenes = buildScenes(420, 210, 'vid-1')
    expect(scenes.length).toBeGreaterThan(0)
    expect(scenes.every((s) => s.sourceId === 'vid-1')).toBe(true)
  })
})
