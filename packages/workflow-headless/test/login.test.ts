import { describe, expect, it } from 'vitest'
import { loginUrl, loginViaRelay } from '../src/login.js'
import type { PageLike } from '../src/page.js'

/**
 * A page whose URL is scripted: each `goto` lands where `landings` says
 * (a private harness bounces to the relay; a public one stays put), and a
 * submit returns to the harness.
 */
function scriptedPage(landings: Record<string, string>, base: string) {
  let href = 'about:blank'
  const gotos: string[] = []
  const fills: string[] = []
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
  }
  return { page: page as unknown as PageLike, gotos, fills }
}

const BASE = 'https://workflow-mcp.j5s.dev'
const LOGIN = 'https://admin.j5s.dev/login?redirect=https%3A%2F%2Fworkflow-mcp.j5s.dev%2F&tryRefresh=true'
const creds = { email: 'm@example', password: 'pw' }

describe('loginUrl', () => {
  it("is the relay login CE's gate redirects to, derived from the harness host", () => {
    expect(loginUrl(BASE)).toBe(LOGIN)
    expect(loginUrl('https://workflow.j5s.dev/')).toBe('https://admin.j5s.dev/login?redirect=https%3A%2F%2Fworkflow.j5s.dev%2F&tryRefresh=true')
    expect(loginUrl('http://localhost:5173')).toBe('http://localhost:5173/login?redirect=http%3A%2F%2Flocalhost%3A5173%2F&tryRefresh=true')
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
