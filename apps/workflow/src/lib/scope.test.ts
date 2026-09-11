/**
 * The "All runs" toggle's own state (spec 11 §What the person sees, D27).
 *
 * It is view state that has to reach a *request*, so it lives in
 * `localStorage` and is read synchronously — `http.ts` and `fetchBaseQuery`'s
 * `prepareHeaders` both build headers outside React, where a Redux read is not
 * available. These cases pin the two things that follow from that: the default
 * is always "mine" (an absent or hostile storage widens nothing), and
 * `scopeHeaders()` answers whatever was last written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCOPE_HEADER as GATE_SCOPE_HEADER } from '../mcp/runGate'
import { SCOPE_HEADER, isAllScopeRole, readScope, scopeHeaders, writeScope } from './scope'

afterEach(() => {
  vi.restoreAllMocks()
  writeScope('mine')
})

describe('readScope / writeScope', () => {
  it('defaults to the caller’s own runs', () => {
    expect(readScope()).toBe('mine')
  })

  it('remembers a widened scope and narrows back', () => {
    writeScope('all')
    expect(readScope()).toBe('all')

    writeScope('mine')
    expect(readScope()).toBe('mine')
  })

  it('reads "mine" when storage refuses (private mode, a quota, a sandboxed frame)', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('nope')
    })

    expect(readScope()).toBe('mine')
    expect(scopeHeaders()).toEqual({})
  })

  it('never throws when storage refuses a write', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('nope')
    })

    expect(() => writeScope('all')).not.toThrow()
  })

  it('treats a value it did not write as "mine"', () => {
    window.localStorage.setItem('workflow.runsScope', 'everything')

    expect(readScope()).toBe('mine')
  })
})

describe('scopeHeaders', () => {
  it('sends nothing while the toggle is off — the ask is never implicit (D27)', () => {
    expect(scopeHeaders()).toEqual({})
  })

  it('sends the ask while the toggle is on', () => {
    writeScope('all')

    expect(scopeHeaders()).toEqual({ [SCOPE_HEADER]: 'all' })
    expect(SCOPE_HEADER).toBe('x-workflow-scope')
    // The name the SPA sends is the name the gate reads — a header nobody
    // reads is a toggle that silently does nothing.
    expect(SCOPE_HEADER).toBe(GATE_SCOPE_HEADER)
  })
})

describe('isAllScopeRole', () => {
  it('is the project owner and admin, and nobody else', () => {
    expect(isAllScopeRole('owner')).toBe(true)
    expect(isAllScopeRole('admin')).toBe(true)
    expect(isAllScopeRole('OWNER')).toBe(true)
    expect(isAllScopeRole('contributor')).toBe(false)
    expect(isAllScopeRole('viewer')).toBe(false)
    expect(isAllScopeRole('')).toBe(false)
    expect(isAllScopeRole(undefined)).toBe(false)
  })
})
