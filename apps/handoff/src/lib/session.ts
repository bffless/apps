/**
 * Session hook for the Handoff app.
 *
 * Mirrors repos/example-project/src/lib/useSession.ts — same pattern, same
 * deduplication strategy. Talks to the BFFless built-in auth relay endpoints.
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

/** Module-level singleton — dedupes concurrent calls within a session. */
let inFlight: Promise<Session> | null = null

const SESSION_URL = '/_bffless/auth/session'

/**
 * Attempt to refresh an expired session, returning true if a refresh succeeded.
 *
 * handoff.j5s.dev is a *subdomain of the primary domain* j5s.dev, so the session
 * lives in the SuperTokens `sAccessToken` / `sRefreshToken` cookies shared on
 * `.j5s.dev` — there is no `bffless_access` / `bffless_refresh` cookie here (those
 * only exist on cross-origin custom domains). The built-in `/_bffless/auth/refresh`
 * only knows how to refresh the latter, so on this subdomain an expired token has
 * no refresh path and the user gets bounced to login — unlike the admin portal,
 * whose SuperTokens SDK transparently calls `/api/auth/session/refresh`.
 *
 * We do the same thing the SDK does: POST the SuperTokens refresh endpoint. The
 * `/api/auth/*` proxy rule (forwardCookies: ON) forwards the path-scoped
 * `sRefreshToken` cookie to the backend and relays the rotated Set-Cookie headers
 * back, minting a fresh `sAccessToken`. The legacy relay refresh is kept as a
 * fallback so the flow stays correct if handoff is ever served from a true
 * cross-origin custom domain.
 */
async function attemptRefresh(): Promise<boolean> {
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

export async function fetchSessionOnce(): Promise<Session> {
  const tryGet = async (): Promise<Response> =>
    fetch(SESSION_URL, { credentials: 'include' })

  let result = await evaluate(await tryGet())

  if (result === 'needs-refresh') {
    const refreshed = await attemptRefresh()
    result = refreshed ? await evaluate(await tryGet()) : { authenticated: false }
  }

  // A second 'needs-refresh' (refresh succeeded but session still not authed)
  // collapses to guest — don't loop.
  return result === 'needs-refresh' ? { authenticated: false } : result
}

function getSession(): Promise<Session> {
  if (!inFlight) {
    inFlight = fetchSessionOnce().catch(() => ({ authenticated: false } as Session))
  }
  return inFlight
}

export function useSession(): { session: Session | null; loading: boolean; refetch: () => void } {
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
 * Build the admin login relay URL that redirects back to `returnUrl` after sign-in.
 */
export function adminLoginUrl(returnUrl: string): string {
  return `https://admin.j5s.dev/login?redirect=${encodeURIComponent(returnUrl)}`
}

/**
 * Build the admin logout relay URL. Mirror of `adminLoginUrl` — bounces through
 * the admin host so SuperTokens revokes the session shared on `.j5s.dev`, then
 * redirects back to `returnUrl`.
 */
export function adminLogoutUrl(returnUrl: string): string {
  return `https://admin.j5s.dev/logout?redirect=${encodeURIComponent(returnUrl)}`
}

/**
 * Full sign-out. Symmetric to the sign-in flow:
 *
 * 1. POST `/_bffless/auth/logout` to clear the per-domain relay cookies
 *    (`bffless_access` / `bffless_refresh`). This is a no-op on `j5s.dev`
 *    subdomains, where those cookies are never set, but is harmless and keeps
 *    the flow correct for any future cross-origin custom domain.
 * 2. Bounce through `admin.j5s.dev/logout` so SuperTokens revokes the real
 *    session and clears `sAccessToken` on `.j5s.dev`, then returns here.
 *
 * Navigating straight to `/_bffless/auth/logout` (a POST-only endpoint) with a
 * GET is what produced the original 404 — and it could never clear the
 * SuperTokens session anyway.
 *
 * Return target is always the handoff **homepage**, never the current page:
 *
 * - After sign-out the user is a guest, so returning to a private sub-path
 *   (e.g. a `/r/<id>` share view) would just re-gate them to login.
 * - The admin `/logout` page invalidates its session, and its always-mounted
 *   Header refetches it — briefly racing a redirect-to-login against
 *   `LogoutPage`'s own redirect. The homepage resolves in a single fast `200`,
 *   so its navigation commits and unloads the admin page before that refetch
 *   can hijack to `/login`. A sub-path that `302`s to stored content commits
 *   slower and loses that race, stranding the user on
 *   `admin.j5s.dev/login?redirect=/logout`. Homepage avoids both.
 */
export async function logout(returnUrl: string = window.location.origin + '/'): Promise<void> {
  try {
    await fetch('/_bffless/auth/logout', { method: 'POST', credentials: 'include' })
  } catch {
    // ignore — the admin bounce below is the source of truth
  }
  window.location.href = adminLogoutUrl(returnUrl)
}
