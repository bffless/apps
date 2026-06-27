/**
 * Regression tests for the session refresh flow.
 *
 * handoff.j5s.dev is a subdomain of the primary domain, so an expired
 * SuperTokens session must be refreshed via `/api/auth/session/refresh`
 * (proxied to the CE backend), exactly like the admin portal's SDK does.
 * Before the fix the app only refreshed on a 401 and never recovered from the
 * 200 `{ authenticated: false }` that the backend returns for an expired
 * (vs genuinely-absent) session — so users were silently logged out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchSessionOnce, attemptRefresh, fetchWithReauth } from './session'

type Route = (init?: RequestInit) => Response

const USER = { id: 'u1', email: 'a@b.dev', role: 'admin' }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Build a fetch stub that dispatches on URL, recording calls. */
function mockFetch(routes: Record<string, Route>) {
  const calls: string[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url)
    const route = routes[url]
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    return route(init)
  })
  vi.stubGlobal('fetch', fn)
  return { calls }
}

const SESSION = '/_bffless/auth/session'
const ST_REFRESH = '/api/auth/session/refresh'
const RELAY_REFRESH = '/_bffless/auth/refresh'

afterEach(() => vi.unstubAllGlobals())

describe('fetchSessionOnce', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the user without refreshing when the session is already valid', async () => {
    const { calls } = mockFetch({
      [SESSION]: () => json(200, { authenticated: true, user: USER }),
    })

    await expect(fetchSessionOnce()).resolves.toEqual({ authenticated: true, user: USER })
    expect(calls).toEqual([SESSION])
    expect(calls).not.toContain(ST_REFRESH)
  })

  it('refreshes via SuperTokens and recovers when the token is expired (200 guest shape)', async () => {
    let refreshed = false
    const { calls } = mockFetch({
      [SESSION]: () =>
        refreshed
          ? json(200, { authenticated: true, user: USER })
          : json(200, { authenticated: false, user: null }),
      [ST_REFRESH]: () => {
        refreshed = true
        return new Response(null, { status: 200 })
      },
    })

    await expect(fetchSessionOnce()).resolves.toEqual({ authenticated: true, user: USER })
    expect(calls).toEqual([SESSION, ST_REFRESH, SESSION])
  })

  it('refreshes via SuperTokens and recovers on an explicit 401', async () => {
    let refreshed = false
    const { calls } = mockFetch({
      [SESSION]: () =>
        refreshed
          ? json(200, { authenticated: true, user: USER })
          : new Response('try refresh token', { status: 401 }),
      [ST_REFRESH]: () => {
        refreshed = true
        return new Response(null, { status: 200 })
      },
    })

    await expect(fetchSessionOnce()).resolves.toEqual({ authenticated: true, user: USER })
    expect(calls).toEqual([SESSION, ST_REFRESH, SESSION])
  })

  it('stays a guest when no refresh token exists (both refresh paths 401)', async () => {
    const { calls } = mockFetch({
      [SESSION]: () => json(200, { authenticated: false, user: null }),
      [ST_REFRESH]: () => new Response(null, { status: 401 }),
      [RELAY_REFRESH]: () => new Response(null, { status: 401 }),
    })

    await expect(fetchSessionOnce()).resolves.toEqual({ authenticated: false })
    // tried SuperTokens first, then the relay fallback; never re-fetched session
    expect(calls).toEqual([SESSION, ST_REFRESH, RELAY_REFRESH])
  })

  it('falls back to the relay refresh when SuperTokens refresh fails', async () => {
    let refreshed = false
    const { calls } = mockFetch({
      [SESSION]: () =>
        refreshed
          ? json(200, { authenticated: true, user: USER })
          : json(200, { authenticated: false, user: null }),
      [ST_REFRESH]: () => new Response(null, { status: 401 }),
      [RELAY_REFRESH]: () => {
        refreshed = true
        return new Response(null, { status: 200 })
      },
    })

    await expect(fetchSessionOnce()).resolves.toEqual({ authenticated: true, user: USER })
    expect(calls).toEqual([SESSION, ST_REFRESH, RELAY_REFRESH, SESSION])
  })
})

describe('attemptRefresh (single-flight)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dedupes concurrent callers into one refresh request', async () => {
    const { calls } = mockFetch({
      [ST_REFRESH]: () => new Response(null, { status: 200 }),
    })

    // Three callers race (the session check + two data-layer 401s on load).
    const results = await Promise.all([attemptRefresh(), attemptRefresh(), attemptRefresh()])

    expect(results).toEqual([true, true, true])
    // SuperTokens rotates the refresh token — only ONE refresh may go out.
    expect(calls.filter((c) => c === ST_REFRESH)).toHaveLength(1)
  })

  it('resets so a later expiry can refresh again', async () => {
    const { calls } = mockFetch({
      [ST_REFRESH]: () => new Response(null, { status: 200 }),
    })

    await attemptRefresh()
    await attemptRefresh()

    // Sequential (not concurrent) calls each refresh — the singleton cleared.
    expect(calls.filter((c) => c === ST_REFRESH)).toHaveLength(2)
  })
})

describe('fetchWithReauth', () => {
  beforeEach(() => vi.clearAllMocks())

  const GATED = '/api/uploads/content/abc'

  it('refreshes once and retries on a 401, returning the retried response', async () => {
    let authed = false
    const { calls } = mockFetch({
      [GATED]: () => (authed ? new Response('payload', { status: 200 }) : new Response(null, { status: 401 })),
      [ST_REFRESH]: () => {
        authed = true
        return new Response(null, { status: 200 })
      },
    })

    const res = await fetchWithReauth(GATED)

    expect(res.status).toBe(200)
    await expect(res.text()).resolves.toBe('payload')
    expect(calls).toEqual([GATED, ST_REFRESH, GATED])
  })

  it('passes through a successful response without refreshing', async () => {
    const { calls } = mockFetch({
      [GATED]: () => new Response('payload', { status: 200 }),
    })

    const res = await fetchWithReauth(GATED)

    expect(res.status).toBe(200)
    expect(calls).toEqual([GATED])
  })

  it('returns the 401 when the refresh itself fails (no infinite retry)', async () => {
    const { calls } = mockFetch({
      [GATED]: () => new Response(null, { status: 401 }),
      [ST_REFRESH]: () => new Response(null, { status: 401 }),
      [RELAY_REFRESH]: () => new Response(null, { status: 401 }),
    })

    const res = await fetchWithReauth(GATED)

    expect(res.status).toBe(401)
    // one initial try, both refresh paths attempted, then NO retry
    expect(calls).toEqual([GATED, ST_REFRESH, RELAY_REFRESH])
  })
})
