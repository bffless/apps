import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  adminOrigin,
  adminLoginUrl,
  adminLogoutUrl,
  fetchSessionOnce,
} from './session'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('adminOrigin', () => {
  it('prefers the VITE_ADMIN_URL override and strips trailing slashes', () => {
    vi.stubEnv('VITE_ADMIN_URL', 'https://admin.example.com//')
    expect(adminOrigin()).toBe('https://admin.example.com')
  })

  it('falls back to the current host for a single-label host (localhost)', () => {
    // jsdom default host is localhost, which has no primary-domain label to swap.
    expect(adminOrigin()).toBe(window.location.origin)
  })
})

describe('adminLoginUrl / adminLogoutUrl', () => {
  it('encodes the return URL as a redirect param on the admin host', () => {
    vi.stubEnv('VITE_ADMIN_URL', 'https://admin.example.com')
    const ret = 'https://reader.example.com/folder/1?x=2'
    expect(adminLoginUrl(ret)).toBe(
      `https://admin.example.com/login?redirect=${encodeURIComponent(ret)}`,
    )
    expect(adminLogoutUrl(ret)).toBe(
      `https://admin.example.com/logout?redirect=${encodeURIComponent(ret)}`,
    )
  })
})

describe('fetchSessionOnce', () => {
  it('returns the authenticated user on a 200 with a user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ authenticated: true, user: { id: 'u1', email: 'a@b.c' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    await expect(fetchSessionOnce()).resolves.toEqual({
      authenticated: true,
      user: { id: 'u1', email: 'a@b.c' },
    })
  })

  it('settles on guest when the session check 401s and the refresh also 401s', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchSessionOnce()).resolves.toEqual({ authenticated: false })
    // session check → refresh attempt (both 401) → no re-check.
    expect(fetchMock).toHaveBeenCalled()
  })

  it('reads the proxied SuperTokens endpoint first and skips the relay when it authenticates', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        calls.push(String(url))
        return new Response(
          JSON.stringify({ authenticated: true, user: { id: 'u1', role: 'admin' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    await expect(fetchSessionOnce()).resolves.toEqual({
      authenticated: true,
      user: { id: 'u1', role: 'admin' },
    })
    // The proxied SuperTokens session is authoritative on a primary subdomain,
    // so it must be tried first and the under-hydrating relay never touched.
    expect(calls[0]).toBe('/api/auth/session')
    expect(calls).not.toContain('/_bffless/auth/session')
  })

  it('falls back to the relay session when the proxied endpoint reads as guest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url)
        // Proxied read: authenticated guest (custom domain carries no sAccessToken).
        if (u === '/api/auth/session') {
          return new Response(JSON.stringify({ authenticated: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        // Both refresh paths fail, so the proxied resolve settles on guest.
        if (u.endsWith('/refresh')) return new Response(null, { status: 401 })
        // Relay read: the custom-domain cookie authenticates.
        if (u === '/_bffless/auth/session') {
          return new Response(
            JSON.stringify({ authenticated: true, user: { id: 'relay-user' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(null, { status: 404 })
      }),
    )
    await expect(fetchSessionOnce()).resolves.toEqual({
      authenticated: true,
      user: { id: 'relay-user' },
    })
  })
})
