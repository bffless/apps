/**
 * The login (Decision 13) — a **member login through the admin relay**, not an
 * injected API key.
 *
 * 07 used to say "inject `X-API-Key` on every request via route interception".
 * That is disproved: two of the harness's relays forward the caller's cookies,
 * and an API key cannot mint a SuperTokens session, so the driver has to sign
 * in the way a person does. `WORKFLOW_TOKEN` survives as an *extra* header on
 * `/api/workflow/*` reads (see `api.ts`), never as the credential.
 *
 * The shape is the one `localdev-tools/workflow-live.mjs` has walked against
 * the live instance: open the harness, let it bounce to the relay's `/login`,
 * fill the two fields, submit, and wait for the URL to come back to the
 * harness origin.
 */
import { DriverError, EXIT } from './errors.js'
import type { PageLike } from './page.js'

export interface Credentials {
  email: string
  password: string
}

const onLogin = (href: string) => /\/login/.test(href)

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
  if (!onLogin(page.url())) return

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
