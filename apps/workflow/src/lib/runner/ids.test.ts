import { describe, expect, it, vi } from 'vitest'
import { newOwnerId, newRunId } from './ids'

const ULID = '[0-9A-HJKMNP-TV-Z]{26}'

describe('newRunId', () => {
  it('matches the run_<ulid> shape', () => {
    expect(newRunId()).toMatch(new RegExp(`^run_${ULID}$`))
  })

  it('generates 1000 unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newRunId()))
    expect(ids.size).toBe(1000)
  })

  it('is lexicographically increasing across two Date.now() ticks', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_700_000_000_000)
      const first = Array.from({ length: 20 }, () => newRunId()).sort()
      vi.setSystemTime(1_700_000_000_001)
      const second = Array.from({ length: 20 }, () => newRunId()).sort()
      expect(second[0]! > first[first.length - 1]!).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('newOwnerId', () => {
  it('matches the tab_<ulid> shape', () => {
    expect(newOwnerId()).toMatch(new RegExp(`^tab_${ULID}$`))
  })
})
