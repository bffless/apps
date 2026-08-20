import { describe, expect, it } from 'vitest'
import { parseDuration } from './durations'

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['3s', 3000],
    ['10m', 600000],
    ['1h', 3600000],
  ] as const)('parses %s to %d ms', (input, expected) => {
    expect(parseDuration(input)).toBe(expected)
  })

  it.each(['5', '3 s', 's'])('throws RangeError for %s', (input) => {
    expect(() => parseDuration(input)).toThrow(RangeError)
  })
})
