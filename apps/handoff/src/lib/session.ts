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
