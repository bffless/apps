import { describe, expect, it } from 'vitest'
import { isSafeUrl, isServeUrl } from './url'

describe('isSafeUrl', () => {
  it.each([
    'https://example.com/x',
    'http://example.com',
    'mailto:a@b.c',
    '/api/uploads/x',
    './x',
    '../x',
    '#top',
    'plain',
  ])('allows %j', (url) => {
    expect(isSafeUrl(url)).toBe(true)
  })

  it.each([
    'javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,hi',
    'vbscript:x',
    '&#106;avascript:x',
  ])('refuses %j', (url) => {
    expect(isSafeUrl(url)).toBe(false)
  })

  // apps#370 / plan Decision 15: a protocol-relative url is an off-site url
  // wearing a root-relative path's clothes, and `ui/open-link` is its first
  // untrusted-by-design caller.
  it.each([
    '//evil.example/x',
    '/\\evil.example/x',
    '/ /evil.example/x',
    '/\t/evil.example/x',
    '\\\\evil.example/x',
  ])('refuses the protocol-relative %j', (url) => {
    expect(isSafeUrl(url)).toBe(false)
  })
})

/**
 * The final whole-branch review (I1/I2): `files.fetch` (a script) and `fetchPayload` (the
 * read path) both take a url off an untrusted run row, so the gate is not
 * "same-origin" but "the file-serve route" — a rooted `/api/uploads/…` path,
 * after the same normalization `isSafeUrl` does and after dot segments are
 * resolved away.
 */
describe('isServeUrl', () => {
  it.each([
    '/api/uploads/a/b.json',
    '/api/uploads/workflows/hello/hello/inputs/u1/cat.png',
    '/api/uploads/x?download=1',
    '/api/uploads/my file.png',
  ])('allows the serve url %j', (url) => {
    expect(isServeUrl(url)).toBe(true)
  })

  it.each([
    // Off-site wearing a rooted path's clothes — `new URL(x, origin)` resolves
    // both of these cross-origin.
    '/\\evil.example/x',
    '//evil.example/x',
    '\t/\\evil.example/x',
    'https://evil.example/api/uploads/x',
    // Same-origin, but another route: a script must not read the run API or
    // another implementation's bundle with the member's cookies.
    '/api/workflow/run?id=1',
    '/w/other/scripts/steal.js',
    // …nor climb out of the serve route with dot segments.
    '/api/uploads/../workflow/run',
    '/api/uploads/%2e%2e/workflow/run',
    // Not rooted at all.
    'api/uploads/x',
    '',
  ])('refuses %j', (url) => {
    expect(isServeUrl(url)).toBe(false)
  })

  it('refuses anything that is not a string', () => {
    expect(isServeUrl(undefined)).toBe(false)
    expect(isServeUrl({ url: '/api/uploads/x' })).toBe(false)
  })
})
