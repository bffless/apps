/**
 * TDD tests for pure share helpers — written BEFORE the implementation.
 */
import { describe, it, expect } from 'vitest'
import { shareLinkCopyUrl, pickReusableToken, shouldClaimToken } from './share'
import type { ShareLink } from '../store/handoffApi'

function link(over: Partial<ShareLink> = {}): ShareLink {
  return { token: 't1', folderId: 'f1', url: '/s/t1', expiresAt: null, revoked: false, ...over }
}

describe('shareLinkCopyUrl', () => {
  it('builds a file-direct URL when nodeId is provided', () => {
    expect(shareLinkCopyUrl('https://h.dev', link({ token: 'abc' }), 'n9')).toBe('https://h.dev/r/n9?token=abc')
  })
  it('builds the folder /s URL when nodeId is absent', () => {
    expect(shareLinkCopyUrl('https://h.dev', link({ url: '/s/abc' }))).toBe('https://h.dev/s/abc')
  })
})

describe('pickReusableToken', () => {
  it('returns the first active link', () => {
    expect(pickReusableToken([link({ token: 'a' }), link({ token: 'b' })], 1000)?.token).toBe('a')
  })
  it('skips revoked and expired links', () => {
    const rev = link({ token: 'r', revoked: true })
    const exp = link({ token: 'e', expiresAt: 500 })
    const ok = link({ token: 'ok' })
    expect(pickReusableToken([rev, exp, ok], 1000)?.token).toBe('ok')
  })
  it('returns null when none usable / empty / undefined', () => {
    expect(pickReusableToken([link({ revoked: true })], 1000)).toBeNull()
    expect(pickReusableToken([], 1000)).toBeNull()
    expect(pickReusableToken(undefined, 1000)).toBeNull()
  })
  it('treats a null-expiry link as active far in the future', () => {
    expect(pickReusableToken([link({ expiresAt: null })], 9e15)?.token).toBe('t1')
  })
})

describe('shouldClaimToken', () => {
  it('claims when token present and not authenticated', () => {
    expect(shouldClaimToken({ token: 'x', authenticated: false })).toBe(true)
  })
  it('does not claim without a token', () => {
    expect(shouldClaimToken({ token: null, authenticated: false })).toBe(false)
  })
  it('does not claim when authenticated', () => {
    expect(shouldClaimToken({ token: 'x', authenticated: true })).toBe(false)
  })
})
