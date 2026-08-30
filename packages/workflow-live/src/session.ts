/**
 * The shared Playwright session every browser-driven walk opens: launch
 * Chromium, sign in through the harness's admin login relay (`loginViaRelay`),
 * and record what the page does — console errors, failed responses, and the
 * two response shapes a walk cares about (`files/register`, `run/delete`).
 *
 * `pageApi` and `loginViaRelay` are typed against `PageLike` (workflow-headless's
 * structural subset of Playwright's `Page`, used so the driver's own unit
 * suite never launches a browser). Playwright's `Page` satisfies `PageLike`
 * structurally, so no cast is needed at either call site — see task-3-report.md.
 *
 * `registered` and `deleteBody` are filled in by response listeners that read
 * the body asynchronously — they only reflect every response seen so far once
 * the caller `await`s every promise in `pending` (e.g. `await Promise.all(s.pending)`).
 *
 * `consoleErrors`/`failed` start counting after the relay login; pre-auth
 * SuperTokens 401s are expected and live only in `log`.
 */
import { mkdir } from 'node:fs/promises'
import { loginViaRelay, pageApi, type ApiLike, type FileRef } from '@bffless/workflow-headless'
import { chromium, type Browser, type Page } from 'playwright'

export interface Session {
  base: string
  page: Page
  api: ApiLike
  consoleErrors: string[]
  failed: string[]
  log: string[]
  registered: FileRef[]
  pending: Promise<unknown>[]
  deleteBody: unknown
  deleteStatus: number | null
  shot(name: string): Promise<void>
  close(): Promise<void>
}

export interface SessionOptions {
  base: string
  out: string
  credentials: { email: string; password: string }
}

export type Classified = { kind: 'register' } | { kind: 'delete' } | { kind: 'other' }

export function classify(url: string, method: string, status: number, hasApiKey: boolean): Classified {
  if (/\/api\/workflow\/files\/register$/.test(url) && status === 200) return { kind: 'register' }
  if (/\/api\/workflow\/run\/delete$/.test(url) && method === 'POST' && !hasApiKey) return { kind: 'delete' }
  return { kind: 'other' }
}

/**
 * Query parameters whose values are credentials: presigned-URL signatures
 * (GCS / S3) and share-link tokens. A walk's `network.log` and report
 * evidence travel into issues and PR comments, so these are blanked at the
 * point of capture — unconditionally, there is no un-redacted mode (#507).
 */
const REDACTED_PARAMS = new Set([
  'X-Goog-Signature',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Goog-Credential',
  'sig',
  'signature',
  'token',
])

/**
 * Replace the value of every query parameter in `REDACTED_PARAMS` with `…`,
 * leaving the pathname, every other parameter and the fragment untouched.
 * Works on the raw string rather than through `URL` so nothing else is
 * re-encoded — `?repository=bffless%2Fworkflow` must survive verbatim for
 * the D8 log checks.
 */
export function redactUrl(url: string): string {
  const q = url.indexOf('?')
  if (q === -1) return url
  const hash = url.indexOf('#', q)
  const query = hash === -1 ? url.slice(q + 1) : url.slice(q + 1, hash)
  const fragment = hash === -1 ? '' : url.slice(hash)
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      const name = eq === -1 ? pair : pair.slice(0, eq)
      return REDACTED_PARAMS.has(name) ? `${name}=…` : pair
    })
    .join('&')
  return `${url.slice(0, q)}?${redacted}${fragment}`
}

export async function openSession(o: SessionOptions): Promise<Session> {
  await mkdir(o.out, { recursive: true }).catch(() => undefined)
  const browser: Browser = await chromium.launch({ args: ['--no-sandbox'], handleSIGINT: false })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const s: Session = {
    base: o.base,
    page,
    api: pageApi(page, { base: o.base }),
    consoleErrors: [],
    failed: [],
    log: [],
    registered: [],
    pending: [],
    deleteBody: null,
    deleteStatus: null,
    shot: (name) => page.screenshot({ path: `${o.out}/${name}.png`, fullPage: true }).then(() => undefined).catch(() => undefined),
    close: () => browser.close().catch(() => undefined),
  }
  page.on('console', (m) => {
    if (m.type() === 'error') s.consoleErrors.push(m.text())
  })
  page.on('response', (r) => {
    const url = r.url()
    const status = r.status()
    const method = r.request().method()
    // `log` / `failed` are what `network.log` and the report carry — store
    // them redacted. `classify` keeps the raw URL (it matches on the path).
    const line = `${status} ${method} ${redactUrl(url)}`
    s.log.push(line)
    if (status >= 400) s.failed.push(line)
    const c = classify(url, method, status, r.request().headers()['x-api-key'] !== undefined)
    if (c.kind === 'register') {
      s.pending.push(r.json().then((b) => s.registered.push(b as FileRef)).catch(() => undefined))
    }
    if (c.kind === 'delete') {
      s.deleteStatus = status
      s.pending.push(r.json().then((b) => { s.deleteBody = b }).catch(() => undefined))
    }
  })
  try {
    await loginViaRelay(page, o.base, o.credentials)
  } catch (e) {
    await s.shot('login-failed')
    await browser.close().catch(() => undefined)
    throw e
  }
  // Pre-auth SuperTokens session probes on the relay's login page (401s) are
  // expected noise, not a walk failure — drop them from the verdict arrays.
  // `log` keeps the full narrative, 401s included.
  s.consoleErrors.length = 0
  s.failed.length = 0
  return s
}
