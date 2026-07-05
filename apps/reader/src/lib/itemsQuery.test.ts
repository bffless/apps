import { describe, expect, it } from 'vitest'
import { buildItemsQuery, PAGE_SIZE, viewOf } from './itemsQuery'
import type { Selection } from './river'

describe('viewOf', () => {
  it('maps each selection kind to its view string', () => {
    expect(viewOf({ kind: 'river' })).toBe('river')
    expect(viewOf({ kind: 'all' })).toBe('all')
    expect(viewOf({ kind: 'starred' })).toBe('starred')
    expect(viewOf({ kind: 'feed', url: 'https://a.com/f' })).toBe('feed')
    expect(viewOf({ kind: 'folder', name: 'Tech' })).toBe('folder')
  })
})

describe('PAGE_SIZE', () => {
  it('is 20', () => {
    expect(PAGE_SIZE).toBe(20)
  })
})

describe('buildItemsQuery — newest order', () => {
  it('sets view, feedId, page, limit for a feed selection and reverse=false', () => {
    const sel: Selection = { kind: 'feed', url: 'u' }
    const { params, reverse } = buildItemsQuery(sel, 1, 20, 'newest', null)
    expect(params.get('view')).toBe('feed')
    expect(params.get('feedId')).toBe('u')
    expect(params.get('page')).toBe('1')
    expect(params.get('limit')).toBe('20')
    expect(reverse).toBe(false)
  })

  it('sets folder for a folder selection', () => {
    const sel: Selection = { kind: 'folder', name: 'Tech' }
    const { params } = buildItemsQuery(sel, 1, 20, 'newest', null)
    expect(params.get('view')).toBe('folder')
    expect(params.get('folder')).toBe('Tech')
    expect(params.has('feedId')).toBe(false)
  })

  it('sets only view for river, all, and starred selections', () => {
    const selections: Selection[] = [{ kind: 'river' }, { kind: 'all' }, { kind: 'starred' }]
    for (const sel of selections) {
      const { params } = buildItemsQuery(sel, 1, 20, 'newest', null)
      expect(params.get('view')).toBe(sel.kind)
      expect(params.has('feedId')).toBe(false)
      expect(params.has('folder')).toBe(false)
    }
  })

  it('does not set reverse=true for newest regardless of total', () => {
    const sel: Selection = { kind: 'river' }
    expect(buildItemsQuery(sel, 1, 20, 'newest', 45).reverse).toBe(false)
    expect(buildItemsQuery(sel, 3, 20, 'newest', null).reverse).toBe(false)
  })
})

describe('buildItemsQuery — oldest order with known total', () => {
  it('maps page=1 to the last server page and sets reverse=true', () => {
    // total=45, limit=20 → totalPages = ceil(45/20) = 3
    const sel: Selection = { kind: 'river' }
    const { params, reverse } = buildItemsQuery(sel, 1, 20, 'oldest', 45)
    expect(params.get('page')).toBe('3')
    expect(reverse).toBe(true)
  })

  it('maps the last client page back to server page 1', () => {
    const sel: Selection = { kind: 'river' }
    const { params, reverse } = buildItemsQuery(sel, 3, 20, 'oldest', 45)
    expect(params.get('page')).toBe('1')
    expect(reverse).toBe(true)
  })

  it('clamps serverPage into [1, totalPages] for out-of-range pages', () => {
    const sel: Selection = { kind: 'river' }
    // page beyond totalPages would compute serverPage < 1 — clamp to 1.
    expect(buildItemsQuery(sel, 10, 20, 'oldest', 45).params.get('page')).toBe('1')
    // page <= 0 would compute serverPage > totalPages — clamp to totalPages (3).
    expect(buildItemsQuery(sel, 0, 20, 'oldest', 45).params.get('page')).toBe('3')
  })

  it('treats total=0 as totalPages=1 (max(1, ceil(0/limit)))', () => {
    const sel: Selection = { kind: 'river' }
    const { params, reverse } = buildItemsQuery(sel, 1, 20, 'oldest', 0)
    expect(params.get('page')).toBe('1')
    expect(reverse).toBe(true)
  })

  it('still carries the view/feedId/folder params under oldest order', () => {
    const sel: Selection = { kind: 'feed', url: 'u' }
    const { params } = buildItemsQuery(sel, 1, 20, 'oldest', 45)
    expect(params.get('view')).toBe('feed')
    expect(params.get('feedId')).toBe('u')
    expect(params.get('limit')).toBe('20')
  })
})

describe('buildItemsQuery — oldest order with unknown total (first load)', () => {
  it('falls back to serverPage=page and reverse=false', () => {
    const sel: Selection = { kind: 'river' }
    const { params, reverse } = buildItemsQuery(sel, 1, 20, 'oldest', null)
    expect(params.get('page')).toBe('1')
    expect(reverse).toBe(false)
  })

  it('falls back with the requested client page number, not always 1', () => {
    const sel: Selection = { kind: 'river' }
    const { params, reverse } = buildItemsQuery(sel, 3, 20, 'oldest', null)
    expect(params.get('page')).toBe('3')
    expect(reverse).toBe(false)
  })
})
