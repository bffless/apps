import { describe, it, expect } from 'vitest'
import { toComment, toCommentList, threadsFor } from './comments'

describe('toComment', () => {
  it('coerces a full record, parsing anchorJson and reactionsJson strings', () => {
    const c = toComment({
      id: 'c1', nodeId: 'n1', parentId: '', authorId: 'u1', authorName: 'a@b.c',
      body: 'hi', anchorJson: '{"type":"text","quote":"q","prefix":"p","suffix":"s","start":5,"end":6}',
      resolved: 'true', resolvedBy: 'u2', resolvedMs: 10, reactionsJson: '{"👍":["u1"]}',
      deleted: false, createdMs: 1, updatedMs: 2,
    })
    expect(c).toEqual({
      id: 'c1', nodeId: 'n1', parentId: null, authorId: 'u1', authorName: 'a@b.c',
      body: 'hi', anchor: { type: 'text', quote: 'q', prefix: 'p', suffix: 's', start: 5, end: 6 },
      resolved: true, resolvedBy: 'u2', resolvedMs: 10, reactions: { '👍': ['u1'] },
      deleted: false, createdMs: 1, updatedMs: 2,
    })
  })

  it('never throws on garbage: bad anchor JSON → null, bad reactions → {}', () => {
    const c = toComment({ id: 1, anchorJson: '{nope', reactionsJson: 42, resolved: 'false' })
    expect(c.id).toBe('1')
    expect(c.anchor).toBeNull()
    expect(c.reactions).toEqual({})
    expect(c.resolved).toBe(false)
    expect(c.parentId).toBeNull()
    expect(c.deleted).toBe(false)
  })

  it('accepts an already-parsed anchor object and a pin anchor', () => {
    const c = toComment({ id: 'c', anchorJson: { type: 'pin', x: 0.5, y: 0.25 } })
    expect(c.anchor).toEqual({ type: 'pin', x: 0.5, y: 0.25 })
  })

  it('rejects anchors of unknown type or out-of-range pin coords', () => {
    expect(toComment({ id: 'c', anchorJson: { type: 'blob' } }).anchor).toBeNull()
    expect(toComment({ id: 'c', anchorJson: { type: 'pin', x: 2, y: 0 } }).anchor).toBeNull()
  })

  it('coerces ISO-8601 timestamp strings (ce#562: CE now() writes ISO into number-typed fields)', () => {
    const created = '2026-07-28T10:32:44.333Z'
    const updated = '2026-07-28T11:00:00.000Z'
    const resolved = '2026-07-28T12:00:00.000Z'
    const c = toComment({ id: 'c', createdMs: created, updatedMs: updated, resolvedMs: resolved })
    expect(c.createdMs).toBe(Date.parse(created))
    expect(c.updatedMs).toBe(Date.parse(updated))
    expect(c.resolvedMs).toBe(Date.parse(resolved))
  })

  it('garbage timestamp strings still fall back to safe defaults', () => {
    const c = toComment({ id: 'c', createdMs: 'not-a-date', updatedMs: 'nope', resolvedMs: 'nope' })
    expect(c.createdMs).toBe(0)
    expect(c.updatedMs).toBeNull()
    expect(c.resolvedMs).toBeNull()
  })
})

describe('toCommentList', () => {
  it('unwraps { comments: [...] } and drops non-objects', () => {
    expect(toCommentList({ comments: [{ id: 'a' }, null, 'x'] }).map((c) => c.id)).toEqual(['a'])
    expect(toCommentList(null)).toEqual([])
  })
})

describe('threadsFor', () => {
  const mk = (id: string, over: Record<string, unknown> = {}) => toComment({ id, nodeId: 'n', ...over })
  it('groups replies under roots, sorts roots by anchor position then createdMs', () => {
    const list = [
      mk('r2', { anchorJson: { type: 'text', quote: 'b', prefix: '', suffix: '', start: 90, end: 91 }, createdMs: 1 }),
      mk('r1', { anchorJson: { type: 'text', quote: 'a', prefix: '', suffix: '', start: 10, end: 11 }, createdMs: 2 }),
      mk('rep1', { parentId: 'r2', createdMs: 5 }),
      mk('rep0', { parentId: 'r2', createdMs: 3 }),
      mk('orphan', { parentId: 'missing' }),
    ]
    const threads = threadsFor(list)
    expect(threads.map((t) => t.root.id)).toEqual(['r1', 'r2'])
    expect(threads[1].replies.map((r) => r.id)).toEqual(['rep0', 'rep1'])
  })
  it('sorts pin roots by y and unanchored roots (anchor null) last by createdMs', () => {
    const threads = threadsFor([
      mk('pin', { anchorJson: { type: 'pin', x: 0.1, y: 0.9 }, createdMs: 9 }),
      mk('none', { createdMs: 1 }),
      mk('txt', { anchorJson: { type: 'text', quote: 'q', prefix: '', suffix: '', start: 1, end: 2 } }),
    ])
    expect(threads.map((t) => t.root.id)).toEqual(['txt', 'pin', 'none'])
  })

  it('drops a soft-deleted root with no surviving replies (orphan husk)', () => {
    const threads = threadsFor([mk('deadroot', { deleted: true })])
    expect(threads).toEqual([])
  })

  it('keeps a soft-deleted root that still has surviving replies', () => {
    const list = [
      mk('deadroot', { deleted: true }),
      mk('rep1', { parentId: 'deadroot', createdMs: 5 }),
    ]
    const threads = threadsFor(list)
    expect(threads.map((t) => t.root.id)).toEqual(['deadroot'])
    expect(threads[0].replies.map((r) => r.id)).toEqual(['rep1'])
  })
})
