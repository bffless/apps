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

async function fetchSessionOnce(): Promise<Session> {
  const tryGet = async (): Promise<Response> =>
    fetch('/_bffless/auth/session', { credentials: 'include' })

  let res = await tryGet()
  if (res.status === 401) {
    const refresh = await fetch('/_bffless/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
    if (refresh.ok) res = await tryGet()
  }

  if (!res.ok) return { authenticated: false }

  const body = (await res.json()) as {
    authenticated?: boolean
    user?: SessionUser | null
  } & Partial<SessionUser>

  if (body?.authenticated === false || body?.user === null) {
    return { authenticated: false }
  }

  const user = (body.user ?? (body as SessionUser)) as SessionUser
  if (!user || typeof user !== 'object' || !('id' in user)) {
    return { authenticated: false }
  }

  return { authenticated: true, user }
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
