/**
 * Session refresh for the harness.
 *
 * The harness is served at `workflow.<primary-domain>` — a subdomain of the
 * primary domain — so the session lives in the SuperTokens `sAccessToken` /
 * `sRefreshToken` cookies shared on `.<primary-domain>`. A refresh POSTs
 * SuperTokens' own route directly; it reaches the CE backend through the
 * `/api/auth/*` forwarding rule in `.bffless/proxy-rules/workflow/`
 * (`forwardCookies: true`), which carries the path-scoped `sRefreshToken` and
 * relays the rotated `Set-Cookie` headers back. There is no `/_bffless/auth/*`
 * relay fallback here: the relay only refreshes the `bffless_*` cookies a
 * true cross-origin custom domain gets, and both harness hosts are
 * primary-domain subdomains. (`apps/studio/src/lib/auth.ts` explains the same
 * limitation but keeps a relay fallback anyway, against a future custom
 * domain; the harness has no such plan, so it carries no dead path — decided
 * on apps#707.)
 *
 * Why one module: a run outlives the access token, and when it expires every
 * `/api/*` call — the read side (RTK Query, `store/workflowApi.ts`) and the
 * write side (`httpJsonWithReauth`, `lib/http.ts`) — answers
 * `401 {"message":"try refresh token"}` in the same instant. Both sides go
 * through {@link attemptRefresh}, so the whole app issues exactly one refresh
 * per expiry (apps#707: two module-local promises meant a poll 401 and a
 * `run-step` 401 in the same second each fired their own).
 */

/** SuperTokens' own refresh route, reached through the harness's `/api/auth/*` rule. */
const REFRESH_URL = '/api/auth/session/refresh'

/**
 * SuperTokens *rotates* the refresh token, so two concurrent refreshes race on
 * the same cookie: the first rotation invalidates the token the others hold. A
 * run fans out into many parallel writes/steps that can all 401 at once, so the
 * shared in-flight promise is the common path, not the edge case.
 */
let refreshInFlight: Promise<boolean> | null = null

async function requestRefresh(): Promise<boolean> {
  try {
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { rid: 'session' },
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Refresh an expired session, resolving `true` when it succeeded. Single-flight:
 * concurrent callers — from either the read or the write path — share the one
 * refresh already in flight and reuse its outcome (see {@link refreshInFlight}).
 * A finished attempt, successful or not, clears the slot, so the next 401
 * legitimately starts a new one.
 */
export function attemptRefresh(): Promise<boolean> {
  refreshInFlight ??= requestRefresh().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}
