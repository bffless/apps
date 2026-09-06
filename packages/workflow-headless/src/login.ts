/**
 * The login — two ways in, one outcome: a **SuperTokens session cookie** in
 * the browser context, because that is the only credential the harness page
 * honours (a private deployment's document load carries no header, and two of
 * the harness's relays forward the caller's cookies).
 *
 *  - `loginViaAppToken` (apps#588, CE ≥ 0.4.50): the driver's own credential,
 *    `WORKFLOW_APP_TOKEN`, exchanged for that session through CE's
 *    `POST /api/auth/session/from-app-token` — no email, no password, no
 *    form. The token has to carry the `auth:session` scope; without it CE
 *    refuses with `insufficient_scope`. Preferred whenever the token is set.
 *  - `loginViaRelay` (Decision 13): a **member login through the admin relay**,
 *    the way a person signs in — open the harness, let it bounce to the
 *    relay's `/login`, fill the two fields, submit, and wait for the URL to
 *    come back to the harness origin. The fallback, and the only path against
 *    a CE without the exchange.
 *
 * 07 used to say "inject `X-API-Key` on every request via route interception".
 * That is disproved: an API key cannot mint a SuperTokens session, so
 * `WORKFLOW_TOKEN` survives as an *extra* header on `/api/workflow/*` reads
 * (see `api.ts`), never as the credential.
 */
import { DriverError, EXIT } from './errors.js'
import type { PageLike } from './page.js'

export interface Credentials {
  email: string
  password: string
}

const onLogin = (href: string) => /\/login/.test(href)

/**
 * The admin origin of a harness at `base`: `<app>.<primary…>` →
 * `admin.<primary…>`; a single-label host (localhost) keeps its host — the
 * harness's own `lib/adminOrigin.ts` rule. Both the relay login and the
 * session exchange live there, and a session minted there is scoped to the
 * project's subdomains, which is what makes the harness page signed in.
 */
export function adminOrigin(base: string): string {
  const { protocol, hostname, host } = new URL(base)
  const labels = hostname.split('.')
  const adminHost = labels.length > 1 ? ['admin', ...labels.slice(1)].join('.') : host
  return `${protocol}//${adminHost}`
}

/**
 * The admin relay's login for a harness at `base`, as CE's visibility gate
 * redirects a private deployment to it:
 * `https://admin.<primary…>/login?redirect=<base>/&tryRefresh=true`.
 */
export function loginUrl(base: string): string {
  return `${adminOrigin(base)}/login?redirect=${encodeURIComponent(`${base.replace(/\/+$/, '')}/`)}&tryRefresh=true`
}

/** CE's app-token → session exchange (bffless/ce#752), on the harness's admin origin. */
export function exchangeUrl(base: string): string {
  return `${adminOrigin(base)}/api/auth/session/from-app-token`
}

/** The `code` CE puts in a refusal's body, if the body is that shape. */
function refusalCode(text: string): { code: string; missingScopes: string[] } {
  try {
    const body = JSON.parse(text) as { code?: unknown; missingScopes?: unknown }
    return {
      code: typeof body.code === 'string' ? body.code : '',
      missingScopes: Array.isArray(body.missingScopes) ? body.missingScopes.map(String) : [],
    }
  } catch {
    return { code: '', missingScopes: [] }
  }
}

/**
 * Sign the browser context in from an app token alone.
 *
 * The exchange goes through `page.request` rather than an in-page `fetch`
 * for the one reason `api.ts` gives for doing the opposite everywhere else:
 * there is no signed-in page yet to fetch from, and the whole point is where
 * the cookies land. `page.request` shares the context's cookie jar, so the
 * `Set-Cookie` CE answers with is the session every later in-page `fetch`
 * carries. The request has no body — the token *is* the request.
 *
 * Every refusal is exit 2, and names CE's own `code`, because each one has a
 * different fix and the person reading a CI log has nothing else to go on.
 */
export async function loginViaAppToken(page: PageLike, base: string, token: string): Promise<void> {
  const url = exchangeUrl(base)
  const res = await page.request.post(url, { headers: { Authorization: `Bearer ${token}` } })
  const status = res.status()
  if (status !== 200) {
    const text = await res.text().catch(() => '')
    const { code, missingScopes } = refusalCode(text)
    const refused = (why: string) =>
      new DriverError(`app token login refused (${status} ${code || 'no code'}): ${why}`, EXIT.USAGE)
    if (status === 401) {
      throw refused(`${url} does not accept WORKFLOW_APP_TOKEN — expired, revoked, or not an app token`)
    }
    if (code === 'insufficient_scope') {
      const missing = missingScopes.length > 0 ? missingScopes.join(', ') : 'auth:session'
      throw refused(`the token must be minted with the auth:session scope (missing: ${missing})`)
    }
    if (code === 'token_project_mismatch') {
      throw refused(`the token belongs to a different project than ${base}`)
    }
    if (code === 'user_not_exchangeable') {
      throw refused(`CE will not mint a session for the token's member (${code})`)
    }
    if (status === 404) {
      throw new DriverError(
        `app token login failed: ${url} answered 404 — the CE behind ${base} has no session exchange (needs CE ≥ 0.4.50); set WORKFLOW_EMAIL / WORKFLOW_PASSWORD instead`,
        EXIT.USAGE,
      )
    }
    throw new DriverError(
      `app token login failed: ${url} answered ${status} ${text.slice(0, 200)}`,
      EXIT.USAGE,
    )
  }

  // The session is in the jar; the page still has to be *on* the harness for
  // the driver's in-page fetches to be same-origin. A private deployment's
  // gate bouncing to the relay here means the cookie did not take — say so
  // now, with the URL, rather than let every later call 401.
  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  await page.waitForURL((u) => onLogin(u.href), { timeout: 5_000 }).catch(() => {})
  if (onLogin(page.url())) {
    throw new DriverError(
      `app token login did not sign the harness in: the exchange answered 200 but ${base} still bounced to ${page.url()}`,
      EXIT.USAGE,
    )
  }
}

export async function loginViaRelay(
  page: PageLike,
  base: string,
  credentials: Credentials,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeout = options.timeoutMs ?? 30_000
  const origin = new URL(base).origin

  await page.goto(`${base}/`, { waitUntil: 'networkidle' })
  // The bounce to the relay is a redirect the app makes after it boots, so it
  // may not have happened yet when `goto` resolves. Not reaching /login is a
  // perfectly good outcome — it means the context is already signed in.
  await page.waitForURL((url) => onLogin(url.href), { timeout: 20_000 }).catch(() => {})
  if (!onLogin(page.url())) {
    // A **public** deployment never bounces: its visibility gate lets anonymous
    // callers through, so the page renders signed out and every auth_required
    // rule 401s. Go to the relay's login the way the gate would have sent us —
    // the same `admin.<domain>` the harness derives for itself (lib/adminOrigin.ts).
    // Already signed in? The relay bounces straight back and `onLogin` stays false.
    await page.goto(loginUrl(base), { waitUntil: 'networkidle' })
    await page.waitForURL((url) => onLogin(url.href), { timeout: 20_000 }).catch(() => {})
    if (!onLogin(page.url())) return
  }

  await page.fill('input[type="email"]', credentials.email)
  await page.fill('input[type="password"]', credentials.password)
  await Promise.all([
    page.waitForURL((url) => url.origin === origin, { timeout }),
    page.click('button[type="submit"]'),
  ]).catch((error: unknown) => {
    throw new DriverError(
      `login did not return to ${origin}: ${(error as Error).message}`,
      EXIT.USAGE,
    )
  })

  if (onLogin(page.url())) {
    throw new DriverError(`login was refused (still at ${page.url()})`, EXIT.USAGE)
  }
}
