/**
 * Session refresh for Studio.
 *
 * Studio is served at `studio.<primary-domain>` — a *subdomain of the primary
 * domain* — so the session lives in the SuperTokens `sAccessToken` /
 * `sRefreshToken` cookies shared on `.<primary-domain>`. There is no
 * `bffless_access` / `bffless_refresh` cookie here (those only exist on
 * cross-origin custom domains), which is why the built-in `/_bffless/auth/refresh`
 * relay can't help: it only knows how to refresh the latter.
 *
 * So we do what the admin portal's SuperTokens SDK does — POST the SuperTokens
 * refresh endpoint directly. That reaches the CE backend via the `/api/auth/*`
 * proxy rule in `bffless/studio.proxy-rules.json` (forwardCookies: ON), which
 * forwards the path-scoped `sRefreshToken` and relays the rotated `Set-Cookie`
 * headers back, minting a fresh `sAccessToken`.
 *
 * Why this exists: a long auto-build outlives the access token's TTL. Every
 * `/api/*` call is gated by the proxy middleware, which answers an expired token
 * with `401 {"message":"try refresh token"}`. Studio used to surface that string
 * verbatim as an error and abandon the run; now it refreshes and retries in place.
 */

import { Mutex } from 'async-mutex'

/**
 * SuperTokens *rotates* the refresh token on every refresh, so two concurrent
 * refreshes race on the same `sRefreshToken`: the first rotation invalidates the
 * token the others are holding, failing them and risking a token-theft trip. A
 * long build fans out into many concurrent `/api/*` calls (job polls, per-scene
 * refiners, presigned uploads) that all 401 at once, so this is the common case,
 * not the edge case.
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

  // Fallback: keeps the flow correct if Studio is ever served from a true
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
 * Query — the presigned-upload prepare/register calls and the audio/bytes reads.
 * Mirrors the RTK `baseQueryWithReauth`: on a 401 it runs the shared
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
 * Test-only seam: reset the cached refresh outcome between tests so one test's
 * successful refresh doesn't leak into the next.
 */
export function __resetAuthCache(): void {
  lastRefreshOk = false
}
