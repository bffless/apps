import { describe, expect, it } from 'vitest'
import { isSafeUrl } from './url'

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
