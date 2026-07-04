import { describe, it, expect } from 'vitest'
import {
  DEFAULT_THEME_CHOICE,
  THEME_OPTIONS,
  isThemeChoice,
  resolveTheme,
  resolveThemeChoice,
} from './theme'

describe('THEME_OPTIONS', () => {
  it('offers Light, Dark, and System in that order', () => {
    expect(THEME_OPTIONS.map((o) => o.id)).toEqual(['light', 'dark', 'system'])
  })

  it('defaults to System', () => {
    expect(DEFAULT_THEME_CHOICE).toBe('system')
    expect(THEME_OPTIONS.some((o) => o.id === DEFAULT_THEME_CHOICE)).toBe(true)
  })
})

describe('isThemeChoice', () => {
  it('accepts known choices only', () => {
    expect(isThemeChoice('light')).toBe(true)
    expect(isThemeChoice('dark')).toBe(true)
    expect(isThemeChoice('system')).toBe(true)
    expect(isThemeChoice('sepia')).toBe(false)
    expect(isThemeChoice('')).toBe(false)
    expect(isThemeChoice(null)).toBe(false)
    expect(isThemeChoice(1)).toBe(false)
  })
})

describe('resolveThemeChoice', () => {
  it('returns a stored valid choice unchanged', () => {
    expect(resolveThemeChoice('light')).toBe('light')
    expect(resolveThemeChoice('dark')).toBe('dark')
    expect(resolveThemeChoice('system')).toBe('system')
  })

  it('falls back to the default for missing or invalid values', () => {
    expect(resolveThemeChoice(null)).toBe(DEFAULT_THEME_CHOICE)
    expect(resolveThemeChoice(undefined)).toBe(DEFAULT_THEME_CHOICE)
    expect(resolveThemeChoice('nonsense')).toBe(DEFAULT_THEME_CHOICE)
    expect(resolveThemeChoice(42)).toBe(DEFAULT_THEME_CHOICE)
  })
})

describe('resolveTheme', () => {
  it('honours an explicit choice regardless of the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme('dark', true)).toBe('dark')
  })

  it('follows the OS preference when the choice is System', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('treats an unrecognized choice as the default (System)', () => {
    expect(resolveTheme('bogus', true)).toBe('dark')
    expect(resolveTheme(null, false)).toBe('light')
  })
})
