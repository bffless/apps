/**
 * Session refresh for Recall.
 *
 * Recall is served at `recall.<primary-domain>` — a *subdomain of the primary
 * domain* — so the session lives in the SuperTokens `sAccessToken` /
 * `sRefreshToken` cookies shared on `.<primary-domain>`. There is no
 * `bffless_access` / `bffless_refresh` cookie here (those only exist on
 * cross-origin custom domains), which is why the built-in `/_bffless/auth/refresh`
 * relay can't help: it only knows how to refresh the latter.
 *
 * So we do what the admin portal's SuperTokens SDK does — POST the SuperTokens
 * refresh endpoint directly. That reaches the CE backend via the `/api/auth/*`
 * proxy rule authored in `.bffless/proxy-rules/recall/` (forwardCookies: ON), which
 * forwards the path-scoped `sRefreshToken` and relays the rotated `Set-Cookie`
 * headers back, minting a fresh `sAccessToken`.
 *
 * Why this exists: a long-running search/chat session outlives the access
 * token's TTL. Every `/api/*` call is gated by the proxy middleware, which
 * answers an expired token with `401 {"message":"try refresh token"}`. Without
 * this, that string would surface verbatim as an error; now it refreshes and
 * retries in place.
 */

import { useCallback, useEffect, useState } from 'react'
import { Mutex } from 'async-mutex'

/**
 * SuperTokens *rotates* the refresh token on every refresh, so two concurrent
 * refreshes race on the same `sRefreshToken`: the first rotation invalidates the
 * token the others are holding, failing them and risking a token-theft trip. A
 * burst of concurrent `/api/*` calls (search, chat, uploads) can all 401 at
 * once, so this is the common case, not the edge case.
 *
 * The mutex makes it single-flight: the first 401 acquires it and refreshes;
 * everyone else waits that one refresh out and reuses its outcome. Every 401 path
 * — the RTK base query and `fetchWithReauth` — goes through `attemptRefresh`, so
 * the whole app issues exactly one refresh per expiry.
 */
const refreshMutex = new Mutex()

/** Outcome of the most recent refresh, so waiters don't have to re-run it. */
let lastRefreshOk = false

/** The SuperTokens refresh route: `apiBasePath` (`/api/auth`) + `session/refresh`. */
const SUPERTOKENS_REFRESH_URL = '/api/auth/session/refresh'

/** The per-domain relay refresh — only meaningful on cross-origin custom domains. */
const RELAY_REFRESH_URL = '/_bffless/auth/refresh'

async function doRefresh(): Promise<boolean> {
  // Primary: SuperTokens session refresh (primary domain + its subdomains).
  try {
    const res = await fetch(SUPERTOKENS_REFRESH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { rid: 'session' },
    })
    if (res.ok) return true
  } catch {
    // ignore — fall through to the relay refresh
  }

  // Fallback: keeps the flow correct if Recall is ever served from a true
  // cross-origin custom domain, where `sRefreshToken` can't reach us.
  try {
    const res = await fetch(RELAY_REFRESH_URL, { method: 'POST', credentials: 'include' })
    if (res.ok) return true
  } catch {
    // ignore
  }

  return false
}

/**
 * Refresh an expired session, returning true if it succeeded. Single-flight:
 * concurrent callers share one refresh (see {@link refreshMutex}).
 */
export async function attemptRefresh(): Promise<boolean> {
  if (refreshMutex.isLocked()) {
    await refreshMutex.waitForUnlock()
    return lastRefreshOk
  }

  const release = await refreshMutex.acquire()
  try {
    lastRefreshOk = await doRefresh()
    return lastRefreshOk
  } finally {
    release()
  }
}

/**
 * `fetch` for auth-gated same-origin `/api/*` paths that don't go through RTK
 * Query — the presigned-upload prepare/register calls and any direct asset
 * reads. Mirrors the RTK `baseQueryWithReauth`: on a 401 it runs the shared
 * single-flight refresh and retries once. If a refresh is already in flight it
 * waits that out first, rather than firing a call that's doomed to 401.
 *
 * Always sends credentials, so do NOT use it for direct-to-bucket URLs: a
 * credentialed cross-origin request fails the bucket's CORS check, and a 401
 * from GCS isn't a session problem anyway.
 */
export async function fetchWithReauth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  await refreshMutex.waitForUnlock()

  const opts: RequestInit = { credentials: 'include', ...init }
  const res = await fetch(input, opts)
  if (res.status !== 401) return res

  return (await attemptRefresh()) ? fetch(input, opts) : res
}

/**
 * Session read for the `/admin/*` gate (Task 5, `RequireAdmin`). Ported from
 * `apps/reader/src/lib/session.ts` (same subdomain-of-primary-domain topology as
 * Recall) rather than Studio's `auth.ts`, which has no session-reading capability
 * of its own — Studio doesn't gate its UI on auth client-side.
 */

export type SessionUser = {
  id: string
  email?: string
  role?: string
  [key: string]: unknown
}

export type Session = { authenticated: true; user: SessionUser } | { authenticated: false }

/** Module-level singleton — dedupes concurrent session checks. */
let inFlight: Promise<Session> | null = null

/**
 * Primary session read path: the reverse-proxied SuperTokens session. On the
 * primary domain and its subdomains (e.g. `recall.j5s.dev`) this returns the
 * canonical BFFless user — `{ id, email, role }` — which is what `RequireAdmin`
 * needs to gate on `role === 'admin'`.
 */
const PROXIED_SESSION_URL = '/api/auth/session'

/**
 * Fallback session read path: the built-in per-domain relay, only meaningful on
 * cross-origin custom domains (where there is no `sAccessToken` to read).
 */
const RELAY_SESSION_URL = '/_bffless/auth/session'

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
  // it is indistinguishable from a genuine guest. Treat both as refresh-worthy: a
  // real guest's refresh simply 401s and we settle on `authenticated: false`.
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
 * expired/absent. Always returns a settled Session (never `'needs-refresh'`).
 */
async function resolveSession(url: string): Promise<Session> {
  const tryGet = async (): Promise<Response> => fetch(url, { credentials: 'include' })

  let result = await evaluate(await tryGet())

  if (result === 'needs-refresh') {
    const refreshed = await attemptRefresh()
    result = refreshed ? await evaluate(await tryGet()) : { authenticated: false }
  }

  return result === 'needs-refresh' ? { authenticated: false } : result
}

export async function fetchSessionOnce(): Promise<Session> {
  // Primary: the reverse-proxied SuperTokens session, carrying the canonical
  // BFFless user (id + role) on the primary domain and its subdomains.
  const proxied = await resolveSession(PROXIED_SESSION_URL)
  if (proxied.authenticated) return proxied

  // Fallback: the built-in relay session for cross-origin custom domains.
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

  return { session, loading, refetch }
}

/**
 * Origin of the BFFless admin host that owns the SuperTokens session. Recall is
 * served at `<app>.<primary-domain>` and the admin always lives at
 * `admin.<primary-domain>` — derived by swapping the first hostname label, so a
 * fork works on any instance with no code edit. `VITE_ADMIN_URL` overrides for
 * non-standard topologies or local dev.
 */
export function adminOrigin(): string {
  const override = import.meta.env.VITE_ADMIN_URL as string | undefined
  if (override) return override.replace(/\/+$/, '')
  const { protocol, hostname, host } = window.location
  const labels = hostname.split('.')
  const adminHost = labels.length > 1 ? ['admin', ...labels.slice(1)].join('.') : host
  return `${protocol}//${adminHost}`
}

/** Build the admin login relay URL that redirects back to `returnUrl` after sign-in. */
export function adminLoginUrl(returnUrl: string): string {
  return `${adminOrigin()}/login?redirect=${encodeURIComponent(returnUrl)}`
}

/**
 * Test-only seam: reset the cached refresh outcome between tests so one test's
 * successful refresh doesn't leak into the next.
 */
export function __resetAuthCache(): void {
  lastRefreshOk = false
  inFlight = null
}
