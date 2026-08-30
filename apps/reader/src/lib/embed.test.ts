/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"https://reader.example.com/"}
 *
 * `isTrustedEmbedOrigin` derives the trusted set from `window.location`, and
 * jsdom refuses to redefine `location` once created, so this file runs at a
 * two-label host (`reader.example.com`, primary domain `example.com`) rather
 * than the default `localhost`. The `embedHost` / `embedUrl` cases are
 * host-agnostic and unaffected.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { embedHost, embedUrl, isEmbeddable, isTrustedEmbedOrigin } from './embed'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

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

describe('isTrustedEmbedOrigin', () => {
  it('trusts any https subdomain of our own primary domain, whatever its label', () => {
    expect(isTrustedEmbedOrigin('https://handoff.example.com')).toBe(true)
    expect(isTrustedEmbedOrigin('https://h2.example.com')).toBe(true)
  })

  it('does not trust another domain, even the one the reference deploy used', () => {
    expect(isTrustedEmbedOrigin('https://handoff.j5s.dev')).toBe(false)
    expect(isTrustedEmbedOrigin('https://notexample.com')).toBe(false)
  })

  it('does not trust the apex or a non-https scheme', () => {
    expect(isTrustedEmbedOrigin('https://example.com')).toBe(false)
    expect(isTrustedEmbedOrigin('http://handoff.example.com')).toBe(false)
  })

  it('returns false for an unparseable origin', () => {
    expect(isTrustedEmbedOrigin('not an origin')).toBe(false)
  })

  it('VITE_TRUSTED_EMBED_ORIGINS replaces the rule with an exact-origin list', () => {
    vi.stubEnv('VITE_TRUSTED_EMBED_ORIGINS', 'https://docs.custom.tld/, https://other.tld')
    expect(isTrustedEmbedOrigin('https://docs.custom.tld')).toBe(true)
    expect(isTrustedEmbedOrigin('https://other.tld')).toBe(true)
    // The override is a replacement, not an addition: the same-site rule is off.
    expect(isTrustedEmbedOrigin('https://handoff.example.com')).toBe(false)
    // Exact match only — a subdomain of a listed origin is not listed.
    expect(isTrustedEmbedOrigin('https://sub.other.tld')).toBe(false)
  })

  it('trusts nothing on a single-label host (localhost) unless the env var is set', () => {
    vi.stubGlobal('location', { ...window.location, hostname: 'localhost' })
    expect(isTrustedEmbedOrigin('https://handoff.example.com')).toBe(false)
    expect(isTrustedEmbedOrigin('https://localhost')).toBe(false)

    vi.stubEnv('VITE_TRUSTED_EMBED_ORIGINS', 'https://handoff.example.com')
    expect(isTrustedEmbedOrigin('https://handoff.example.com')).toBe(true)
  })
})

describe('isEmbeddable', () => {
  it('is true for a same-site origin with text/markdown', () => {
    expect(
      isEmbeddable({
        enclosureType: 'text/markdown',
        link: 'https://handoff.example.com/blob/Posts/x.md',
      }),
    ).toBe(true)
  })

  it('is true for a same-site origin with text/html (a Handoff site)', () => {
    expect(
      isEmbeddable({
        enclosureType: 'text/html',
        link: 'https://handoff.example.com/blob/Sites/Portfolio',
      }),
    ).toBe(true)
  })

  it('is true whatever subdomain label Handoff was installed under', () => {
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'https://h2.example.com/blob/x.md' }),
    ).toBe(true)
  })

  it('is false for a same-site origin with a non-embeddable enclosureType', () => {
    const link = 'https://handoff.example.com/blob/Posts/x.md'
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
    // Another instance's Handoff is not ours, even the reference deploy's.
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'https://handoff.j5s.dev/blob/x.md' }),
    ).toBe(false)
    // A look-alike domain is not a subdomain of ours.
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'https://notexample.com/blob/x.md' }),
    ).toBe(false)
  })

  it('is false for the apex of our own primary domain', () => {
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'https://example.com/blob/x.md' }),
    ).toBe(false)
  })

  it('is false when link is null', () => {
    expect(isEmbeddable({ enclosureType: 'text/markdown', link: null })).toBe(false)
  })

  it('is false for an unparseable link', () => {
    expect(isEmbeddable({ enclosureType: 'text/markdown', link: 'not a url' })).toBe(false)
  })

  it('respects an injected trust predicate', () => {
    const item = { enclosureType: 'text/markdown', link: 'https://my.host/blob/x' }
    expect(isEmbeddable(item, (origin) => origin === 'https://my.host')).toBe(true)
    expect(isEmbeddable(item, () => false)).toBe(false)
    expect(isEmbeddable(item, isTrustedEmbedOrigin)).toBe(false)
  })

  it('does not match a different scheme', () => {
    // Only https: is trusted, so http:// on an otherwise same-site host must fail.
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'http://handoff.example.com/blob/x' }),
    ).toBe(false)
  })

  it('does not match a subdomain of another primary domain', () => {
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'https://evil.handoff.j5s.dev/blob/x' }),
    ).toBe(false)
  })

  it('honours VITE_TRUSTED_EMBED_ORIGINS as an exact-origin replacement list', () => {
    vi.stubEnv('VITE_TRUSTED_EMBED_ORIGINS', 'https://docs.custom.tld/, https://other.tld')
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'https://docs.custom.tld/blob/x.md' }),
    ).toBe(true)
    expect(
      isEmbeddable({ enclosureType: 'text/html', link: 'https://other.tld/blob/Sites/x' }),
    ).toBe(true)
    expect(
      isEmbeddable({ enclosureType: 'text/markdown', link: 'https://handoff.example.com/blob/x.md' }),
    ).toBe(false)
  })
})
