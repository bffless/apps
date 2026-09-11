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
import { SCOPE_HEADER, isAllScopeRole, readScope, scopeHeaders, viewUrl, writeScope } from './scope'
import { downloadHref, trustSignedUrl } from './url'

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

/**
 * The sink half of the same ask (apps#665 review). An `<img src>`, a player,
 * a download `href` and a bare `fetch` of a serve url are all fetched by the
 * *browser*, where no header can ride — the gate reads `request.query.scope`
 * as readily as the header (`mcp/runGate.ts`'s `scopeAsked`), so the query
 * string is the channel there. It is applied here, at the sink, and never in
 * `coerce.ts`'s `fileUrl`, whose answer ends up inside File refs that get
 * persisted.
 */
describe('viewUrl', () => {
  const SERVE = '/api/uploads/workflows/hello/hello/runs/run_1/poster.png'

  it('leaves a url alone while the viewer has not widened', () => {
    expect(viewUrl(SERVE)).toBe(SERVE)
  })

  it('appends the ask to a serve url while widened, composing with an existing query', () => {
    writeScope('all')

    expect(viewUrl(SERVE)).toBe(`${SERVE}?scope=all`)
    expect(viewUrl(`${SERVE}?download=1`)).toBe(`${SERVE}?download=1&scope=all`)
  })

  it('composes with the Download action either way round', () => {
    writeScope('all')

    expect(downloadHref(viewUrl(SERVE))).toBe(`${SERVE}?scope=all&download=1`)
  })

  it('touches nothing that is not a serve url — including a url this page presigned', () => {
    writeScope('all')
    const signed = 'https://bucket.example/o/x?sig=abc'
    trustSignedUrl(signed)

    expect(viewUrl(signed)).toBe(signed)
    // …which is what keeps `downloadHref`'s signed-url exception working: it
    // recognises the url by identity, and a decorated one would no longer be
    // the string that was registered (and its signature would be broken).
    expect(downloadHref(viewUrl(signed))).toBe(signed)
    expect(viewUrl('/api/workflow/run?id=run_1')).toBe('/api/workflow/run?id=run_1')
    expect(viewUrl('')).toBe('')
    expect(viewUrl(undefined as never)).toBeUndefined()
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
