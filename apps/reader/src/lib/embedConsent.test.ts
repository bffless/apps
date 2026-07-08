import { afterEach, describe, expect, it } from 'vitest'
import {
  EMBED_ALLOWED_HOSTS_KEY,
  allowOnce,
  isAllowedOnce,
  isHostAllowed,
  loadAllowedHosts,
  persistAllowedHost,
  resetSessionConsent,
} from './embedConsent'

/** Minimal in-memory Storage for injection (no jsdom localStorage needed). */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
}

describe('loadAllowedHosts', () => {
  it('is empty for a missing key', () => {
    expect(loadAllowedHosts(fakeStorage())).toEqual([])
  })

  it('reads a persisted array', () => {
    const s = fakeStorage({ [EMBED_ALLOWED_HOSTS_KEY]: JSON.stringify(['handoff.j5s.dev']) })
    expect(loadAllowedHosts(s)).toEqual(['handoff.j5s.dev'])
  })

  it('tolerates corrupt JSON → []', () => {
    const s = fakeStorage({ [EMBED_ALLOWED_HOSTS_KEY]: '{not json' })
    expect(loadAllowedHosts(s)).toEqual([])
  })

  it('tolerates a non-array value → []', () => {
    const s = fakeStorage({ [EMBED_ALLOWED_HOSTS_KEY]: JSON.stringify({ foo: 1 }) })
    expect(loadAllowedHosts(s)).toEqual([])
  })

  it('drops non-string / empty entries', () => {
    const s = fakeStorage({ [EMBED_ALLOWED_HOSTS_KEY]: JSON.stringify(['a.com', 3, '', null]) })
    expect(loadAllowedHosts(s)).toEqual(['a.com'])
  })

  it('returns [] when storage is null', () => {
    expect(loadAllowedHosts(null)).toEqual([])
  })
})

describe('persistAllowedHost', () => {
  it('adds a host and writes it back', () => {
    const s = fakeStorage()
    expect(persistAllowedHost('handoff.j5s.dev', s)).toEqual(['handoff.j5s.dev'])
    expect(loadAllowedHosts(s)).toEqual(['handoff.j5s.dev'])
  })

  it('dedupes an already-allowed host (no duplicate)', () => {
    const s = fakeStorage({ [EMBED_ALLOWED_HOSTS_KEY]: JSON.stringify(['handoff.j5s.dev']) })
    expect(persistAllowedHost('handoff.j5s.dev', s)).toEqual(['handoff.j5s.dev'])
  })

  it('is a no-op for an empty host', () => {
    const s = fakeStorage()
    expect(persistAllowedHost('', s)).toEqual([])
    expect(loadAllowedHosts(s)).toEqual([])
  })

  it('appends alongside existing hosts', () => {
    const s = fakeStorage({ [EMBED_ALLOWED_HOSTS_KEY]: JSON.stringify(['a.com']) })
    expect(persistAllowedHost('b.com', s)).toEqual(['a.com', 'b.com'])
  })
})

describe('isHostAllowed', () => {
  it('matches a host in the list', () => {
    expect(isHostAllowed('a.com', ['a.com', 'b.com'])).toBe(true)
  })
  it('is false for a host not in the list, and for null/empty', () => {
    expect(isHostAllowed('c.com', ['a.com'])).toBe(false)
    expect(isHostAllowed(null, ['a.com'])).toBe(false)
    expect(isHostAllowed(undefined, ['a.com'])).toBe(false)
    expect(isHostAllowed('', ['a.com'])).toBe(false)
  })
})

describe('session show-once', () => {
  afterEach(() => resetSessionConsent())

  it('marks and reads a shown item', () => {
    expect(isAllowedOnce('item-1')).toBe(false)
    allowOnce('item-1')
    expect(isAllowedOnce('item-1')).toBe(true)
    expect(isAllowedOnce('item-2')).toBe(false)
  })

  it('is false for null/empty ids', () => {
    expect(isAllowedOnce(null)).toBe(false)
    expect(isAllowedOnce('')).toBe(false)
  })

  it('reset clears it', () => {
    allowOnce('item-1')
    resetSessionConsent()
    expect(isAllowedOnce('item-1')).toBe(false)
  })
})
