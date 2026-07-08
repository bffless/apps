import { describe, it, expect } from 'vitest'
import { embedHost, embedUrl, isEmbeddable, TRUSTED_EMBED_ORIGINS } from './embed'

describe('embedHost', () => {
  it('returns the bare host of a viewer link', () => {
    expect(embedHost('https://handoff.j5s.dev/blob/Posts/x.md?token=abc')).toBe('handoff.j5s.dev')
  })

  it('returns null for null/undefined/empty/unparseable', () => {
    expect(embedHost(null)).toBeNull()
    expect(embedHost(undefined)).toBeNull()
    expect(embedHost('')).toBeNull()
    expect(embedHost('not a url')).toBeNull()
  })
})

describe('embedUrl', () => {
  it('appends embed=1 to a bare viewer link', () => {
    const out = embedUrl('https://handoff.j5s.dev/blob/Posts/x.md')
    expect(out).not.toBeNull()
    expect(new URL(out!).searchParams.get('embed')).toBe('1')
  })

  it('preserves an existing token query alongside embed=1', () => {
    const out = embedUrl('https://handoff.j5s.dev/blob/Posts/x.md?token=abc')
    const params = new URL(out!).searchParams
    expect(params.get('token')).toBe('abc')
    expect(params.get('embed')).toBe('1')
  })

  it('returns null for null/undefined/empty', () => {
    expect(embedUrl(null)).toBeNull()
    expect(embedUrl(undefined)).toBeNull()
    expect(embedUrl('')).toBeNull()
  })

  it('returns null for an unparseable link', () => {
    expect(embedUrl('not a url')).toBeNull()
  })
})

describe('isEmbeddable', () => {
  it('is true for a trusted origin with text/markdown', () => {
    expect(
      isEmbeddable({
        enclosureType: 'text/markdown',
        link: 'https://handoff.j5s.dev/blob/Posts/x.md',
      }),
    ).toBe(true)
  })

  it('is true for a trusted origin with text/html (a Handoff site)', () => {
    expect(
      isEmbeddable({
        enclosureType: 'text/html',
        link: 'https://handoff.j5s.dev/blob/Sites/Portfolio',
      }),
    ).toBe(true)
  })

  it('is false for a trusted origin with a non-embeddable enclosureType', () => {
    const link = 'https://handoff.j5s.dev/blob/Posts/x.md'
    expect(isEmbeddable({ enclosureType: 'text/plain', link })).toBe(false)
    expect(isEmbeddable({ enclosureType: 'application/pdf', link })).toBe(false)
    expect(isEmbeddable({ enclosureType: null, link })).toBe(false)
  })

  it('is false for embeddable mimes from an untrusted origin (security)', () => {
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'https://evil.com/blob/x' }),
    ).toBe(false)
    // The forged-mime case: a hostile feed labels a site markdown, but its own
    // origin is untrusted, so it is not embeddable at all.
    expect(
      isEmbeddable({ enclosureType: 'text/html', link: 'https://evil.com/blob/x' }),
    ).toBe(false)
  })

  it('is false when link is null', () => {
    expect(isEmbeddable({ enclosureType: 'text/markdown', link: null })).toBe(false)
  })

  it('is false for an unparseable link', () => {
    expect(isEmbeddable({ enclosureType: 'text/markdown', link: 'not a url' })).toBe(false)
  })

  it('respects an injected trustedOrigins list', () => {
    const item = { enclosureType: 'text/markdown', link: 'https://my.host/blob/x' }
    expect(isEmbeddable(item, ['https://my.host'])).toBe(true)
    expect(isEmbeddable(item, TRUSTED_EMBED_ORIGINS)).toBe(false)
  })

  it('does not match a different scheme not in the allowlist', () => {
    // Only https://handoff.j5s.dev is trusted, so http:// must fail.
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'http://handoff.j5s.dev/blob/x' }),
    ).toBe(false)
  })

  it('does not match a subdomain not in the allowlist', () => {
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'https://evil.handoff.j5s.dev/blob/x' }),
    ).toBe(false)
  })
})
