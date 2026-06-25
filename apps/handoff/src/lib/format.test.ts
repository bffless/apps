import { describe, it, expect } from 'vitest'
import { formatBytes } from './format'

describe('formatBytes', () => {
  it('returns "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('clamps negative values to "0 B"', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(-1024)).toBe('0 B')
  })

  it('returns "—" for non-finite inputs', () => {
    expect(formatBytes(Infinity)).toBe('—')
    expect(formatBytes(-Infinity)).toBe('—')
    expect(formatBytes(NaN)).toBe('—')
  })

  it('formats bytes without a decimal for round values', () => {
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1048576)).toBe('1 MB')
    expect(formatBytes(1073741824)).toBe('1 GB')
  })

  it('formats bytes with one decimal place when needed', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1572864)).toBe('1.5 MB')
  })

  it('handles values just under a boundary', () => {
    expect(formatBytes(1023)).toBe('1023 B')
  })
})
