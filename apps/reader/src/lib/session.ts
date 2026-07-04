/**
 * Session hook for the Rivulet reader.
 *
 * Ported from apps/handoff/src/lib/session.ts — same pattern, same
 * single-flight refresh strategy. Reads the session from the reverse-proxied
 * SuperTokens endpoint (`/api/auth/session`) first, falling back to the
 * built-in relay (`/_bffless/auth/session`) only for cross-origin custom
 * domains, and refreshes via the `/api/auth/*` reverse-proxy rule (D11).
 * Rivulet is served at a subdomain of the primary domain, so the session lives
 * in the shared `sAccessToken` / `sRefreshToken` cookies on `.<primary-domain>`.
 */

import { useEffect, useState, useCallback } from 'react'

export type SessionUser = {
  id: string
  email?: string
  role?: string
  [key: string]: unknown
}

export type Session =
  | { authenticated: true; user: SessionUser }
  | { authenticated: false }

/** Module-level singleton — dedupes concurrent session checks. */
let inFlight: Promise<Session> | null = null

/**
 * Module-level singleton — dedupes concurrent token refreshes. SuperTokens
 * *rotates* the refresh token on every refresh, so two concurrent
 * `/api/auth/session/refresh` calls race on the same `sRefreshToken`: the first
 * rotation invalidates the token the others use, failing them and risking a
 * token-theft trip. Every 401 path awaits this one promise so only a single
 * refresh is ever in flight. This is a 1-permit async mutex.
 */
let refreshInFlight: Promise<boolean> | null = null

/**
 * Primary session read path: the **reverse-proxied SuperTokens** session.
 *
 * On the primary domain and its subdomains (e.g. `reader.j5s.dev`) this returns
 * the canonical BFFless user — `{ id, email, role }` — where `id` is the real
 * BFFless user id and `role` carries `admin`. That identity is what the app
 * needs to gate owner/admin controls, so it must be the primary source.
 *
 * The built-in relay (`/_bffless/auth/session`, below) can't be primary: on a
 * primary-domain subdomain it resolves via the shared `sAccessToken` fallback and
 * returns an *under-hydrated* user (a non-BFFless `id`, no `role`). The relay is
 * only correct on cross-origin custom domains (its `bffless_access` cookie path).
 *
 * This mirrors `doRefresh`, which already prefers the proxied
 * `/api/auth/session/refresh` over the relay refresh.
 */
const PROXIED_SESSION_URL = '/api/auth/session'

/**
 * Fallback session read path: the built-in per-domain relay. Cross-origin custom
 * domains only carry the `bffless_access` relay cookie (no `sAccessToken`), so the
 * proxied endpoint reads as guest there — the relay is what authenticates them.
 */
const RELAY_SESSION_URL = '/_bffless/auth/session'

/**
 * The actual refresh, run at most once at a time via {@link attemptRefresh}.
 *
 * We do what the SuperTokens SDK does: POST the refresh endpoint. The
 * `/api/auth/*` proxy rule (forwardCookies: ON) forwards the path-scoped
 * `sRefreshToken` cookie to the backend and relays the rotated Set-Cookie
 * headers back, minting a fresh `sAccessToken`. The legacy relay refresh is
 * kept as a fallback for a future cross-origin custom domain.
 */
async function doRefresh(): Promise<boolean> {
  // Primary: SuperTokens session refresh (primary domain + its subdomains).
  try {
    const st = await fetch('/api/auth/session/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { rid: 'session' },
    })
    if (st.ok) return true
  } catch {
    // ignore — fall through to the relay refresh
  }

  // Fallback: per-domain relay refresh (cross-origin custom domains only).
  try {
    const relay = await fetch('/_bffless/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    if (relay.ok) return true
  } catch {
    // ignore
  }

  return false
}

/**
 * Attempt to refresh an expired session, returning true if it succeeded.
 * Single-flight: concurrent callers share one in-flight refresh.
 */
export function attemptRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

/**
 * `fetch` for auth-gated `/api/*` paths: on a 401 it runs the shared
 * single-flight refresh and retries once, so an expired access token recovers
 * in place instead of surfacing as a failed load. Always sends credentials.
 * (The data layers land with later stories; this is the shared primitive.)
 */
export async function fetchWithReauth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (refreshInFlight) await refreshInFlight
  const opts: RequestInit = { credentials: 'include', ...init }
  const res = await fetch(input, opts)
  if (res.status === 401 && (await attemptRefresh())) {
    return fetch(input, opts)
  }
  return res
}

type Evaluated = Session | 'needs-refresh'

async function evaluate(res: Response): Promise<Evaluated> {
  // 401 is the explicit "try refresh token" signal.
  if (res.status === 401) return 'needs-refresh'
  if (!res.ok) return { authenticated: false }

  const body = (await res.json()) as {
    authenticated?: boolean
    user?: SessionUser | null
  } & Partial<SessionUser>

  // On the primary subdomain an *expired* SuperTokens session is reported as a
  // 200 `{ authenticated: false }` (the backend swallows TRY_REFRESH_TOKEN), so
  // it is indistinguishable from a genuine guest. Treat both as refresh-worthy:
  // a real guest's refresh simply 401s and we settle on `authenticated: false`.
  if (body?.authenticated === false || body?.user === null) {
    return 'needs-refresh'
  }

  const user = (body.user ?? (body as SessionUser)) as SessionUser
  if (!user || typeof user !== 'object' || !('id' in user)) {
    return { authenticated: false }
  }

  return { authenticated: true, user }
}

/**
 * Resolve the session from a single endpoint, refreshing once if the token is
 * expired/absent. Always returns a settled Session (never `'needs-refresh'`):
 * a second `'needs-refresh'` (refresh succeeded but still not authed) collapses
 * to guest so we don't loop.
 */
async function resolveSession(url: string): Promise<Session> {
  const tryGet = async (): Promise<Response> =>
    fetch(url, { credentials: 'include' })

  let result = await evaluate(await tryGet())

  if (result === 'needs-refresh') {
    const refreshed = await attemptRefresh()
    result = refreshed ? await evaluate(await tryGet()) : { authenticated: false }
  }

  return result === 'needs-refresh' ? { authenticated: false } : result
}

export async function fetchSessionOnce(): Promise<Session> {
  // Primary: the reverse-proxied SuperTokens session, which carries the canonical
  // BFFless user (id + role) on the primary domain and its subdomains. If this
  // authenticates, it is authoritative — return it before touching the relay,
  // whose sAccessToken fallback would under-hydrate id/role on a subdomain.
  const proxied = await resolveSession(PROXIED_SESSION_URL)
  if (proxied.authenticated) return proxied

  // Fallback: the built-in relay session for cross-origin custom domains, where
  // the proxied endpoint reads as guest (no sAccessToken) but the relay cookie
  // authenticates. On the primary domain this simply stays a guest.
  return resolveSession(RELAY_SESSION_URL)
}

function getSession(): Promise<Session> {
  if (!inFlight) {
    inFlight = fetchSessionOnce().catch(() => ({ authenticated: false }) as Session)
  }
  return inFlight
}

export function useSession(): {
  session: Session | null
  loading: boolean
  refetch: () => void
} {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  const refetch = useCallback(() => {
    inFlight = null
    setLoading(true)
    setSession(null)
    setTick((n) => n + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    getSession().then((s) => {
      if (!cancelled) {
        setSession(s)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [tick])

  useEffect(() => {
    const onChange = () => refetch()
    window.addEventListener('bffless:auth:refetch', onChange)
    return () => window.removeEventListener('bffless:auth:refetch', onChange)
  }, [refetch])

  return { session, loading, refetch }
}

/**
 * Origin of the BFFless **admin host** that owns the SuperTokens session.
 *
 * Rivulet is served at `<app>.<primary-domain>` and the admin always lives at
 * `admin.<primary-domain>`. We derive that by swapping the first hostname label
 * for `admin`, so a fork works on **any** instance with no code edit. Set
 * `VITE_ADMIN_URL` (e.g. `https://admin.example.com`) to override for
 * non-standard topologies or local dev.
 */
export function adminOrigin(): string {
  const override = import.meta.env.VITE_ADMIN_URL as string | undefined
  if (override) return override.replace(/\/+$/, '')
  const { protocol, hostname, host } = window.location
  const labels = hostname.split('.')
  // <app>.<primary…> → admin.<primary…>; single-label hosts (localhost) left as-is.
  const adminHost = labels.length > 1 ? ['admin', ...labels.slice(1)].join('.') : host
  return `${protocol}//${adminHost}`
}

/** Build the admin login relay URL that redirects back to `returnUrl` after sign-in. */
export function adminLoginUrl(returnUrl: string): string {
  return `${adminOrigin()}/login?redirect=${encodeURIComponent(returnUrl)}`
}

/** Build the admin logout relay URL — bounces through the admin host to revoke the session. */
export function adminLogoutUrl(returnUrl: string): string {
  return `${adminOrigin()}/logout?redirect=${encodeURIComponent(returnUrl)}`
}

/**
 * Full sign-out. Clears the per-domain relay cookies (a no-op on primary-domain
 * subdomains), then bounces through `admin.<primary>/logout` so SuperTokens
 * revokes the real session on `.<primary-domain>` and returns to the homepage.
 */
export async function logout(
  returnUrl: string = window.location.origin + '/',
): Promise<void> {
  try {
    await fetch('/_bffless/auth/logout', { method: 'POST', credentials: 'include' })
  } catch {
    // ignore — the admin bounce below is the source of truth
  }
  window.location.href = adminLogoutUrl(returnUrl)
}
