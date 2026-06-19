import { describe, expect, it } from 'vitest'
import { buildSearchRequest, toSearchHits, MAX_HITS } from './search'

const words = [
  { text: 'hello', start: 0, end: 0.4 },
  { text: 'world', start: 0.5, end: 0.9 },
  { text: 'bike', start: 9, end: 9.4 },
]

describe('buildSearchRequest', () => {
  it('shapes the timed transcript and trims the query', () => {
    const req = buildSearchRequest('  bike ride ', words, 12)
    expect(req.query).toBe('bike ride')
    expect(req.duration).toBe(12)
    expect(req.transcript).toBe('[0:00] hello world\n[0:08] bike')
  })
})

describe('toSearchHits', () => {
  it('returns [] for garbage', () => {
    expect(toSearchHits(null, 10)).toEqual([])
    expect(toSearchHits('nope', 10)).toEqual([])
    expect(toSearchHits({ results: 'nope' }, 10)).toEqual([])
  })

  it('accepts both a bare array and a { results } envelope', () => {
    const hit = { start: 1, end: 3, snippet: 's', reason: 'r' }
    expect(toSearchHits([hit], 10)).toHaveLength(1)
    expect(toSearchHits({ results: [hit] }, 10)).toHaveLength(1)
  })

  it('clamps spans into [0, duration]', () => {
    const [h] = toSearchHits([{ start: -5, end: 99, snippet: '', reason: '' }], 10)
    expect(h).toMatchObject({ start: 0, end: 10 })
  })

  it('drops reversed and sliver spans and non-object entries', () => {
    expect(
      toSearchHits([{ start: 5, end: 4 }, { start: 1, end: 1.1 }, 'junk', null], 10),
    ).toEqual([])
  })

  it('sorts ascending and caps the count', () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({
      start: 29 - i,
      end: 29 - i + 1,
      snippet: '',
      reason: '',
    }))
    const hits = toSearchHits(raw, 60)
    expect(hits).toHaveLength(MAX_HITS)
    expect(hits[0].start).toBeLessThan(hits[1].start)
  })

  it('defaults snippet/reason to empty strings', () => {
    const [h] = toSearchHits([{ start: 0, end: 2 }], 10)
    expect(h.snippet).toBe('')
    expect(h.reason).toBe('')
  })
})
