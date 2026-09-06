import { describe, expect, it } from 'vitest'
import { EXIT } from '../src/errors.js'
import { exchangeUrl, loginUrl, loginViaAppToken, loginViaRelay } from '../src/login.js'
import type { PageLike } from '../src/page.js'

/** What the scripted page's `request.post` answers — the exchange's status and body. */
interface Exchange {
  status: number
  body?: unknown
}

/**
 * A page whose URL is scripted: each `goto` lands where `landings` says
 * (a private harness bounces to the relay; a public one stays put), and a
 * submit returns to the harness. `request.post` is the browser context's
 * request client, answering `exchange` and recording what it was sent.
 */
function scriptedPage(landings: Record<string, string>, base: string, exchange: Exchange = { status: 200, body: { id: 'u1' } }) {
  let href = 'about:blank'
  const gotos: string[] = []
  const fills: string[] = []
  const posts: Array<{ url: string; headers: Record<string, string> | undefined }> = []
  const page = {
    async goto(url: string) {
      gotos.push(url)
      href = landings[url] ?? url
    },
    url: () => href,
    async fill(_selector: string, value: string) {
      fills.push(value)
    },
    async click(selector: string) {
      if (selector === 'button[type="submit"]') href = `${base}/`
    },
    // A real page polls; the submit's navigation lands a tick after the click.
    async waitForURL(predicate: (url: URL) => boolean) {
      for (let i = 0; i < 5; i++) {
        if (predicate(new URL(href))) return
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      throw new Error('Timeout')
    },
    request: {
      async post(url: string, options?: { headers?: Record<string, string> }) {
        posts.push({ url, headers: options?.headers })
        return {
          status: () => exchange.status,
          text: async () => (exchange.body === undefined ? '' : JSON.stringify(exchange.body)),
        }
      },
    },
  }
  return { page: page as unknown as PageLike, gotos, fills, posts }
}

const BASE = 'https://workflow-mcp.j5s.dev'
const LOGIN = 'https://admin.j5s.dev/login?redirect=https%3A%2F%2Fworkflow-mcp.j5s.dev%2F&tryRefresh=true'
const EXCHANGE = 'https://admin.j5s.dev/api/auth/session/from-app-token'
const creds = { email: 'm@example', password: 'pw' }
const TOKEN = 'bfat_abc'

describe('loginUrl', () => {
  it("is the relay login CE's gate redirects to, derived from the harness host", () => {
    expect(loginUrl(BASE)).toBe(LOGIN)
    expect(loginUrl('https://workflow.j5s.dev/')).toBe('https://admin.j5s.dev/login?redirect=https%3A%2F%2Fworkflow.j5s.dev%2F&tryRefresh=true')
    expect(loginUrl('http://localhost:5173')).toBe('http://localhost:5173/login?redirect=http%3A%2F%2Flocalhost%3A5173%2F&tryRefresh=true')
  })
})

describe('exchangeUrl', () => {
  it('is the session exchange on the same admin origin the relay login lives on', () => {
    expect(exchangeUrl(BASE)).toBe(EXCHANGE)
    expect(exchangeUrl('https://workflow.j5s.dev/')).toBe(EXCHANGE)
    expect(exchangeUrl('http://localhost:5173')).toBe('http://localhost:5173/api/auth/session/from-app-token')
  })
})

describe('loginViaRelay', () => {
  it('signs in through the bounce a private harness makes', async () => {
    const { page, gotos, fills } = scriptedPage({ [`${BASE}/`]: LOGIN }, BASE)
    await loginViaRelay(page, BASE, creds)
    expect(gotos).toEqual([`${BASE}/`])
    expect(fills).toEqual(['m@example', 'pw'])
    expect(page.url()).toBe(`${BASE}/`)
  })

  it('goes to the relay itself when a public harness does not bounce', async () => {
    const { page, gotos, fills } = scriptedPage({ [`${BASE}/`]: `${BASE}/`, [LOGIN]: LOGIN }, BASE)
    await loginViaRelay(page, BASE, creds)
    expect(gotos).toEqual([`${BASE}/`, LOGIN])
    expect(fills).toEqual(['m@example', 'pw'])
    expect(page.url()).toBe(`${BASE}/`)
  })

  it('does nothing more when the relay bounces straight back (already signed in)', async () => {
    const { page, gotos, fills } = scriptedPage({ [`${BASE}/`]: `${BASE}/`, [LOGIN]: `${BASE}/` }, BASE)
    await loginViaRelay(page, BASE, creds)
    expect(gotos).toEqual([`${BASE}/`, LOGIN])
    expect(fills).toEqual([])
  })
})

describe('loginViaAppToken', () => {
  /**
   * The whole mechanism: the exchange runs through the browser context's
   * request client (so the cookies CE sets land in the jar the page's `fetch`
   * reads), as a bare Bearer POST on the admin origin — no body, no form —
   * and only then does the page open the harness, which must not bounce.
   */
  it('exchanges the token on the admin origin, then opens the harness signed in', async () => {
    const { page, gotos, fills, posts } = scriptedPage({ [`${BASE}/`]: `${BASE}/` }, BASE)
    await loginViaAppToken(page, BASE, TOKEN)
    expect(posts).toEqual([{ url: EXCHANGE, headers: { Authorization: `Bearer ${TOKEN}` } }])
    // The exchange comes first; the relay's form is never touched.
    expect(gotos).toEqual([`${BASE}/`])
    expect(fills).toEqual([])
    expect(page.url()).toBe(`${BASE}/`)
  })

  const refused = (exchange: Exchange) => {
    const { page, gotos } = scriptedPage({ [`${BASE}/`]: `${BASE}/` }, BASE, exchange)
    return loginViaAppToken(page, BASE, TOKEN).then(
      () => {
        throw new Error('did not throw')
      },
      (error: unknown) => ({ error: error as { code: number; message: string }, gotos }),
    )
  }

  it('a 401 is a refused token — exit 2, naming the code, and the harness is never opened', async () => {
    const { error, gotos } = await refused({ status: 401, body: { code: 'unauthorized' } })
    expect(error.code).toBe(EXIT.USAGE)
    expect(error.message).toContain('unauthorized')
    expect(error.message).toContain('WORKFLOW_APP_TOKEN')
    expect(gotos).toEqual([])
  })

  it('403 insufficient_scope says the token must be minted with auth:session', async () => {
    const { error } = await refused({ status: 403, body: { code: 'insufficient_scope', missingScopes: ['auth:session'] } })
    expect(error.code).toBe(EXIT.USAGE)
    expect(error.message).toContain('insufficient_scope')
    expect(error.message).toMatch(/mint(ed)? .*auth:session/)
  })

  it('403 token_project_mismatch names the harness the token does not belong to', async () => {
    const { error } = await refused({ status: 403, body: { code: 'token_project_mismatch' } })
    expect(error.code).toBe(EXIT.USAGE)
    expect(error.message).toContain('token_project_mismatch')
    expect(error.message).toContain(BASE)
  })

  it('409 user_not_exchangeable is a refusal too, not a driver fault', async () => {
    const { error } = await refused({ status: 409, body: { code: 'user_not_exchangeable' } })
    expect(error.code).toBe(EXIT.USAGE)
    expect(error.message).toContain('user_not_exchangeable')
  })

  it('a 404 says the CE behind the harness has no exchange (older than 0.4.50)', async () => {
    const { error } = await refused({ status: 404 })
    expect(error.code).toBe(EXIT.USAGE)
    expect(error.message).toContain('404')
    expect(error.message).toContain('0.4.50')
  })

  it('an exchange that answered 200 but a harness that still bounces is a refusal', async () => {
    // The cookie did not take — a harness on a domain the session cookie is
    // not scoped to. Not a silent signed-out page: the page's later 401s would
    // be far harder to read than this.
    const { page } = scriptedPage({ [`${BASE}/`]: LOGIN }, BASE)
    const error = await loginViaAppToken(page, BASE, TOKEN).then(
      () => null,
      (thrown: unknown) => thrown as { code: number; message: string },
    )
    expect(error?.code).toBe(EXIT.USAGE)
    expect(error?.message).toContain(LOGIN)
  })
})
