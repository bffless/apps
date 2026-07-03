import { describe, it, expect } from 'vitest'
import { keyToAction, nextSelection } from './keyboard'

describe('keyToAction', () => {
  it('maps j/k to cursor moves', () => {
    expect(keyToAction('j')).toEqual({ kind: 'move', dir: 'next' })
    expect(keyToAction('k')).toEqual({ kind: 'move', dir: 'prev' })
  })

  it('maps space to page down', () => {
    expect(keyToAction(' ')).toEqual({ kind: 'page' })
  })

  it('maps s/m to star and toggle-read', () => {
    expect(keyToAction('s')).toEqual({ kind: 'star' })
    expect(keyToAction('m')).toEqual({ kind: 'toggleRead' })
  })

  it('maps o and Enter to open', () => {
    expect(keyToAction('o')).toEqual({ kind: 'open' })
    expect(keyToAction('Enter')).toEqual({ kind: 'open' })
  })

  it('ignores unhandled and shifted keys', () => {
    expect(keyToAction('x')).toBeNull()
    expect(keyToAction('J')).toBeNull() // shift held — not a shortcut
    expect(keyToAction('Escape')).toBeNull()
  })
})

describe('nextSelection', () => {
  const guids = ['a', 'b', 'c']

  it('from no selection, next lands on the first and prev on the last', () => {
    expect(nextSelection(guids, null, 'next')).toBe('a')
    expect(nextSelection(guids, null, 'prev')).toBe('c')
  })

  it('steps forward and back through the list', () => {
    expect(nextSelection(guids, 'a', 'next')).toBe('b')
    expect(nextSelection(guids, 'b', 'next')).toBe('c')
    expect(nextSelection(guids, 'c', 'prev')).toBe('b')
  })

  it('clamps at the edges — no wrap-around', () => {
    expect(nextSelection(guids, 'c', 'next')).toBe('c')
    expect(nextSelection(guids, 'a', 'prev')).toBe('a')
  })

  it('treats an unknown current guid as no selection', () => {
    expect(nextSelection(guids, 'gone', 'next')).toBe('a')
    expect(nextSelection(guids, 'gone', 'prev')).toBe('c')
  })

  it('returns null for an empty list', () => {
    expect(nextSelection([], 'a', 'next')).toBeNull()
    expect(nextSelection([], null, 'prev')).toBeNull()
  })
})
