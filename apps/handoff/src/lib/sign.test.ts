/**
 * Unit tests for `toSignedUrl` — the defensive coercion that extracts a
 * usable URL from the POST /api/sign response shape.
 *
 * TDD order: these tests were written BEFORE the implementation so they
 * all start RED, then go GREEN once sign.ts is implemented.
 */

import { describe, it, expect } from 'vitest'
import { toSignedUrl } from './sign'

describe('toSignedUrl', () => {
  // Happy-path: standard { signed: { url } } contract
  it('returns signed.url when present and non-empty', () => {
    expect(toSignedUrl({ signed: { url: 'https://storage.googleapis.com/bucket/key?sig=abc' } }))
      .toBe('https://storage.googleapis.com/bucket/key?sig=abc')
  })

  // Fallback: flat { url } shape
  it('falls back to top-level url when signed is absent', () => {
    expect(toSignedUrl({ url: 'https://y.example.com/file' }))
      .toBe('https://y.example.com/file')
  })

  it('prefers signed.url over top-level url', () => {
    expect(toSignedUrl({ signed: { url: 'https://primary.example.com/' }, url: 'https://fallback.example.com/' }))
      .toBe('https://primary.example.com/')
  })

  // Trimming
  it('trims whitespace from signed.url', () => {
    expect(toSignedUrl({ signed: { url: '  https://trimmed.example.com/  ' } }))
      .toBe('https://trimmed.example.com/')
  })

  it('trims whitespace from top-level url', () => {
    expect(toSignedUrl({ url: '  https://trimmed-flat.example.com/  ' }))
      .toBe('https://trimmed-flat.example.com/')
  })

  // Reject empty strings
  it('returns null when signed.url is an empty string', () => {
    expect(toSignedUrl({ signed: { url: '' } })).toBeNull()
  })

  it('returns null when signed.url is whitespace-only', () => {
    expect(toSignedUrl({ signed: { url: '   ' } })).toBeNull()
  })

  it('returns null when url is an empty string', () => {
    expect(toSignedUrl({ url: '' })).toBeNull()
  })

  it('returns null when url is whitespace-only', () => {
    expect(toSignedUrl({ url: '   ' })).toBeNull()
  })

  // Null / missing / garbage inputs — never throws
  it('returns null for null', () => {
    expect(toSignedUrl(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(toSignedUrl(undefined)).toBeNull()
  })

  it('returns null for a number', () => {
    expect(toSignedUrl(42)).toBeNull()
  })

  it('returns null for a string', () => {
    expect(toSignedUrl('https://raw-string.com/')).toBeNull()
  })

  it('returns null for an empty object', () => {
    expect(toSignedUrl({})).toBeNull()
  })

  it('returns null when signed exists but url is null', () => {
    expect(toSignedUrl({ signed: { url: null } })).toBeNull()
  })

  it('returns null when signed exists but url is a number', () => {
    expect(toSignedUrl({ signed: { url: 42 } })).toBeNull()
  })

  it('returns null when signed is null', () => {
    expect(toSignedUrl({ signed: null })).toBeNull()
  })

  it('returns null when both signed and url are missing', () => {
    expect(toSignedUrl({ other: 'stuff' })).toBeNull()
  })

  it('falls back to top-level url when signed.url is empty', () => {
    expect(
      toSignedUrl({ signed: { url: '   ' }, url: 'https://fallback.example.com/x' }),
    ).toBe('https://fallback.example.com/x')
  })

  it('falls back to top-level url when signed.url is missing', () => {
    expect(
      toSignedUrl({ signed: { foo: 'bar' }, url: 'https://fallback.example.com/y' }),
    ).toBe('https://fallback.example.com/y')
  })
})
