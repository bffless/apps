import { describe, it, expect } from 'vitest'
import { reconcileIndex, pickNewer, toServerRecord, fromServerRecord } from './projectSync'
import { freshWorkingState } from '../store/studioSlice'
import type { ProjectMeta } from './projects'

const meta = (id: string, updatedAt: number, name = id): ProjectMeta =>
  ({ id, name, createdAt: 1, updatedAt, phase: 'prep', thumbnailUrl: null })

describe('reconcileIndex', () => {
  it('adds server-only projects', () => {
    expect(reconcileIndex({}, [meta('a', 5)]).a.name).toBe('a')
  })
  it('keeps local-only projects (unsynced)', () => {
    expect(reconcileIndex({ a: meta('a', 5) }, []).a).toBeDefined()
  })
  it('takes the newer meta by updatedAt (server newer)', () => {
    expect(reconcileIndex({ a: meta('a', 5, 'old') }, [meta('a', 9, 'new')]).a.name).toBe('new')
  })
  it('keeps local when local is newer', () => {
    expect(reconcileIndex({ a: meta('a', 9, 'local') }, [meta('a', 5, 'server')]).a.name).toBe('local')
  })
})

describe('pickNewer', () => {
  it('returns whichever updatedAt is larger', () => {
    expect(pickNewer(meta('a', 5), meta('a', 9)).updatedAt).toBe(9)
    expect(pickNewer(meta('a', 9), meta('a', 5)).updatedAt).toBe(9)
  })
})

describe('server record round-trip', () => {
  it('toServerRecord stringifies working into data', () => {
    const w = freshWorkingState(); w.direction = 'hi'
    const rec = toServerRecord(meta('a', 5, 'A'), w)
    expect(rec.id).toBe('a'); expect(rec.name).toBe('A')
    expect(typeof rec.data).toBe('string')
    expect(JSON.parse(rec.data).direction).toBe('hi')
  })
  it('fromServerRecord parses a STRING data blob', () => {
    const w = freshWorkingState(); w.direction = 'str'
    const back = fromServerRecord(toServerRecord(meta('a', 5), w))
    expect(back.meta.id).toBe('a'); expect(back.working.direction).toBe('str')
  })
  it('fromServerRecord accepts an OBJECT data blob (what GET returns)', () => {
    const back = fromServerRecord({ id: 'a', name: 'A', createdAt: 1, updatedAt: 5, phase: 'prep', thumbnailUrl: null, data: { direction: 'obj', scenes: [] } })
    expect(back.working.direction).toBe('obj')
    expect(Array.isArray(back.working.scenes)).toBe(true)
  })
  it('fromServerRecord tolerates a bad/missing data blob (fresh working)', () => {
    const back = fromServerRecord({ id: 'a', name: 'A', createdAt: 1, updatedAt: 5, phase: 'prep', thumbnailUrl: null, data: 'not json' })
    expect(Array.isArray(back.working.scenes)).toBe(true)
  })

  it('round-trips a generated blog post (cross-device restore, issue #72)', () => {
    const w = freshWorkingState()
    w.blog = {
      markdown: '---\ntitle: My Post\n---\n\n# My Post\n\nHello.',
      direction: 'keep it punchy',
      script: 'Hello.',
      status: 'done',
      jobId: null,
    }
    const back = fromServerRecord(toServerRecord(meta('a', 5), w))
    expect(back.working.blog).toEqual(w.blog)
  })
})
