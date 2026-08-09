import { describe, expect, test } from 'vitest'
import { loadFnSource, runFn } from '../test/fnHarness'

type PrepOutput = { ok: boolean; notOk: boolean; reason: string; q: string; textsJson: string }

// PR-feedback-7: prep.fn.js now reads `request.query.q` (a GET query-string
// param), not `request.body.q` — the whole point of converting this rule
// from POST to GET was HTTP cacheability (only GET/HEAD responses are ever
// stored by a conforming cache, per RFC 9111).
const prepFnSrc = loadFnSource('_custom/search-get/get/prep.fn.js')

function run(query: unknown): PrepOutput {
  return runFn(prepFnSrc, { request: { query } }) as PrepOutput
}

describe('_custom/search-get/get/prep.fn.js', () => {
  test('accepts a valid query from request.query.q (not request.body.q)', () => {
    const out = run({ q: 'hugging face token' })
    expect(out).toEqual({
      ok: true,
      notOk: false,
      reason: '',
      q: 'hugging face token',
      textsJson: JSON.stringify(['hugging face token']),
    })
  })

  test('trims whitespace', () => {
    expect(run({ q: '  hello  ' }).q).toBe('hello')
  })

  test('rejects a missing q', () => {
    const out = run({})
    expect(out.ok).toBe(false)
    expect(out.notOk).toBe(true)
    expect(out.reason).toBe('INVALID_QUERY')
  })

  test('rejects a blank/whitespace-only q', () => {
    expect(run({ q: '   ' }).reason).toBe('INVALID_QUERY')
  })

  test('rejects a non-string q', () => {
    expect(run({ q: 42 }).reason).toBe('INVALID_QUERY')
  })

  test('rejects a query over 500 chars', () => {
    const out = run({ q: 'a'.repeat(501) })
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('QUERY_TOO_LONG')
  })

  test('accepts exactly 500 chars', () => {
    expect(run({ q: 'a'.repeat(500) }).ok).toBe(true)
  })

  test('does NOT read from request.body — a body-only q is ignored (query wins/is required)', () => {
    const out = runFn(prepFnSrc, { request: { body: { q: 'ignored' }, query: {} } }) as PrepOutput
    expect(out.ok).toBe(false)
    expect(out.reason).toBe('INVALID_QUERY')
  })

  test('an undefined request object degrades to notOk rather than throwing', () => {
    const out = runFn(prepFnSrc, {}) as PrepOutput
    expect(out.ok).toBe(false)
    expect(out.notOk).toBe(true)
  })
})
