import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WIDTH_LEVEL,
  WIDTH_PRESETS,
  isWidthLevel,
  presetForLevel,
  resolveWidthLevel,
} from './width'

describe('WIDTH_PRESETS', () => {
  it('is ordered lowest → highest starting at the default', () => {
    expect(WIDTH_PRESETS[0].id).toBe(DEFAULT_WIDTH_LEVEL)
    expect(WIDTH_PRESETS.map((p) => p.id)).toEqual(['cozy', 'comfortable', 'wide', 'full'])
  })

  it('reproduces today’s layout at the default level (cozy = max-w-6xl / max-w-2xl)', () => {
    const cozy = presetForLevel('cozy')
    expect(cozy.container).toBe('max-w-6xl')
    expect(cozy.measure).toBe('max-w-2xl')
  })

  it('widens both the container and the measure at every step up', () => {
    // Distinct, non-repeating classes as levels rise — both dimensions grow.
    const containers = WIDTH_PRESETS.map((p) => p.container)
    const measures = WIDTH_PRESETS.map((p) => p.measure)
    expect(new Set(containers).size).toBe(WIDTH_PRESETS.length)
    expect(new Set(measures).size).toBe(WIDTH_PRESETS.length)
    // Top level relaxes the container cap toward full-bleed.
    expect(WIDTH_PRESETS[WIDTH_PRESETS.length - 1].container).toBe('max-w-none')
  })
})

describe('isWidthLevel', () => {
  it('accepts known level ids only', () => {
    expect(isWidthLevel('cozy')).toBe(true)
    expect(isWidthLevel('full')).toBe(true)
    expect(isWidthLevel('huge')).toBe(false)
    expect(isWidthLevel('')).toBe(false)
    expect(isWidthLevel(null)).toBe(false)
    expect(isWidthLevel(3)).toBe(false)
  })
})

describe('resolveWidthLevel', () => {
  it('returns a stored valid level unchanged', () => {
    expect(resolveWidthLevel('wide')).toBe('wide')
    expect(resolveWidthLevel('comfortable')).toBe('comfortable')
  })

  it('falls back to the default for missing or invalid values', () => {
    expect(resolveWidthLevel(null)).toBe(DEFAULT_WIDTH_LEVEL)
    expect(resolveWidthLevel(undefined)).toBe(DEFAULT_WIDTH_LEVEL)
    expect(resolveWidthLevel('nonsense')).toBe(DEFAULT_WIDTH_LEVEL)
    expect(resolveWidthLevel(42)).toBe(DEFAULT_WIDTH_LEVEL)
  })
})

describe('presetForLevel', () => {
  it('maps each level to its preset', () => {
    for (const p of WIDTH_PRESETS) {
      expect(presetForLevel(p.id)).toEqual(p)
    }
  })

  it('returns the default preset for an unknown level', () => {
    expect(presetForLevel('nope')).toEqual(WIDTH_PRESETS[0])
  })
})
