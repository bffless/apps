/**
 * TDD tests for pure share helpers — written BEFORE the implementation.
 */
import { describe, it, expect } from 'vitest'
import { shareLinkCopyUrl, slugifyFilename, pickReusableToken, shouldClaimToken } from './share'
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
  it('inserts a vanity filename segment when fileName is provided', () => {
    expect(shareLinkCopyUrl('https://h.dev', link({ token: 'abc' }), 'n9', 'My Report.rar')).toBe(
      'https://h.dev/r/n9/my-report.rar?token=abc',
    )
  })
  it('omits the segment when fileName is absent (backward compatible)', () => {
    expect(shareLinkCopyUrl('https://h.dev', link({ token: 'abc' }), 'n9')).toBe('https://h.dev/r/n9?token=abc')
  })
})

describe('slugifyFilename', () => {
  it('slugifies the base and lowercases the extension', () => {
    expect(slugifyFilename('My Report (Final).rar')).toBe('my-report-final.rar')
  })
  it('keeps a name with no extension', () => {
    expect(slugifyFilename('README')).toBe('readme')
  })
  it('falls back to "file" when the base slugifies to empty', () => {
    expect(slugifyFilename('报告.pdf')).toBe('file.pdf')
  })
  it('keeps only the last extension for double extensions', () => {
    expect(slugifyFilename('archive.tar.gz')).toBe('archive-tar.gz')
  })
  it('lowercases an uppercase extension', () => {
    expect(slugifyFilename('photo.JPEG')).toBe('photo.jpeg')
  })
  it('treats a dotfile as all-base', () => {
    expect(slugifyFilename('.env')).toBe('env')
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
