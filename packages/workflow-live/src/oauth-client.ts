/**
 * The pieces an OAuth 2.1 public client needs for the `oauth` walk (Phase 3
 * plan, Task C3): a PKCE pair, a one-shot local redirect listener that
 * captures `?code=&state=`, and the RFC 8414 / 9728 fetches.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export interface PkcePair {
  verifier: string
  challenge: string
}

export function pkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export interface Callback {
  code?: string
  state?: string
  error?: string
  error_description?: string
}

/** Listen once on 127.0.0.1:<port> for the redirect; answer the browser a small page; resolve with the query. */
export function waitForCallback(port: number, timeoutMs = 120_000): { url: string; done: Promise<Callback>; close(): void } {
  let settle: (value: Callback) => void = () => undefined
  let fail: (error: Error) => void = () => undefined
  const done = new Promise<Callback>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname !== '/cb') {
      res.writeHead(404).end()
      return
    }
    const q = Object.fromEntries(url.searchParams.entries()) as Callback
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>workflow-live</title><p>Authorized — you can close this tab.</p>')
    settle(q)
  })
  const timer = setTimeout(() => fail(new Error(`no OAuth callback within ${timeoutMs} ms`)), timeoutMs)
  server.listen(port, '127.0.0.1')
  const close = () => {
    clearTimeout(timer)
    server.close()
  }
  return { url: `http://127.0.0.1:${port}/cb`, done: done.finally(close), close }
}

export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  code_challenge_methods_supported?: string[]
}

export interface ProtectedResourceDocument {
  resource: string
  authorization_servers: string[]
  scopes_supported?: string[]
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T | null; headers: Headers }> {
  const res = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } })
  const text = await res.text()
  let body: T | null
  try {
    body = text === '' ? null : (JSON.parse(text) as T)
  } catch {
    body = null
  }
  return { status: res.status, body, headers: res.headers }
}

/** RFC 8414: `<issuer>/.well-known/oauth-authorization-server` (the issuer has no path, so the plain form). */
export function metadataUrlOf(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/oauth-authorization-server`
}

/** The token endpoint, as an OAuth client posts to it (form-encoded). */
export async function postForm<T>(url: string, fields: Record<string, string>): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  })
  const text = await res.text()
  let body: T | null
  try {
    body = text === '' ? null : (JSON.parse(text) as T)
  } catch {
    body = null
  }
  return { status: res.status, body }
}
