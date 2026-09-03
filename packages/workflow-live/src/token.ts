/**
 * App tokens for the walks (Phase 3 plan, Decision 24): the endpoint runs as
 * the caller from story 7 on, so a walk mints its own short-lived token
 * through the browser context it already signed in with — the SuperTokens
 * cookie is on `.<domain>`, and Playwright's `context.request` shares the
 * context's cookie jar, so `admin.<domain>/api/app-tokens` answers as the
 * member with no CORS in the way (it is not an in-page fetch). A person's
 * `WORKFLOW_APP_TOKEN` skips the mint.
 */

/** The slice of Playwright's `APIRequestContext` the mint needs (structural, so tests need no browser). */
export interface RequestLike {
  post(url: string, options: { data: unknown; headers?: Record<string, string> }): Promise<{ status(): number; json(): Promise<unknown>; text(): Promise<string> }>
  delete(url: string): Promise<{ status(): number }>
}

export interface MintedToken {
  id: string
  token: string
  scopes: string[]
  revoke(): Promise<void>
}

/**
 * The admin origin of a harness — `https://workflow-mcp.j5s.dev` →
 * `https://admin.j5s.dev`; a single-label host (localhost) keeps itself. The
 * harness's own `lib/adminOrigin.ts` rule, restated (the walk cannot import
 * the app); `token.test.ts` holds it to `loginUrl`'s host.
 */
export function adminOriginOf(harness: string): string {
  const { protocol, hostname, host } = new URL(harness)
  const labels = hostname.split('.')
  const adminHost = labels.length > 1 ? ['admin', ...labels.slice(1)].join('.') : host
  return `${protocol}//${adminHost}`
}

export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export async function mintAppToken(
  request: RequestLike,
  harness: string,
  project: string,
  scopes: string[],
  name: string,
  options: { ttlMs?: number } = {},
): Promise<MintedToken> {
  const admin = adminOriginOf(harness)
  const expiresAt = new Date(Date.now() + (options.ttlMs ?? DEFAULT_TOKEN_TTL_MS)).toISOString()
  const res = await request.post(`${admin}/api/app-tokens`, { data: { name, project, scopes, expiresAt } })
  if (res.status() !== 201) {
    const body = await res.text().catch(() => '')
    throw new Error(`mint app token: ${admin}/api/app-tokens answered ${res.status()} ${body.slice(0, 200)}`)
  }
  const body = (await res.json()) as { data?: { id?: string; scopes?: string[] }; token?: string }
  if (!body.token || !body.data?.id) throw new Error('mint app token: the answer carries no token')
  const id = body.data.id
  return {
    id,
    token: body.token,
    scopes: body.data.scopes ?? scopes,
    revoke: async () => {
      await request.delete(`${admin}/api/app-tokens/${id}`).catch(() => undefined)
    },
  }
}
