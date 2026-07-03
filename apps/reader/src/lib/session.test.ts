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
})
