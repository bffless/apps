/**
 * Every HTTP call the driver makes goes **through the page**, as in-page
 * `fetch`, never through `page.request` — two reasons, and both bite:
 *
 *  - the credential is the harness's session cookie (Decision 13: a member
 *    login through the admin relay; an API key cannot mint a session), and
 *  - in `--mocks` mode the whole backend is an MSW **service worker**, which
 *    `page.request` bypasses entirely: the request would leave the browser and
 *    hit the Vite dev server, which answers `index.html` for `/api/...`.
 *
 * Bytes cross the bridge as base64 rather than as a typed array: Playwright's
 * argument serialization is only documented for JSON-alikes, and a silently
 * mangled upload is a bug that surfaces hours later as a corrupt file.
 */
import { Buffer } from 'node:buffer'
import type { PageLike } from './page.js'

export interface JsonResponse {
  status: number
  body: unknown
}

export interface ApiLike {
  json(url: string, init?: { method?: string; body?: unknown }): Promise<JsonResponse>
  text(url: string): Promise<{ status: number; body: string }>
  bytes(url: string): Promise<{ status: number; bytes: Uint8Array }>
  put(url: string, bytes: Uint8Array, contentType: string): Promise<{ status: number }>
}

export interface ApiOptions {
  /** The harness origin every relative url resolves against. */
  base: string
  /**
   * `WORKFLOW_TOKEN`, sent as `X-API-Key` on `/api/workflow/*` **reads** only
   * (07): it is an optional extra on top of the session, never a replacement
   * for it, and it has no business on a bucket PUT.
   */
  token?: string
}

/** In-page fetch, as run by `page.evaluate`. */
interface FetchArgs {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  /** base64 body for a PUT; wins over `body` when set. */
  bytes: string | null
  want: 'json' | 'text' | 'bytes' | 'none'
}

interface FetchResult {
  status: number
  text: string
  base64: string
}

async function inPageFetch(page: PageLike, args: FetchArgs): Promise<FetchResult> {
  return page.evaluate<FetchResult, FetchArgs>(async (a: FetchArgs) => {
    let body: BodyInit | undefined
    if (a.bytes !== null) {
      const binary = atob(a.bytes)
      const buffer = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i)
      body = buffer
    } else if (a.body !== null) {
      body = a.body
    }

    const res = await fetch(a.url, {
      method: a.method,
      headers: a.headers,
      credentials: 'include',
      ...(body === undefined ? {} : { body }),
    })

    if (a.want === 'bytes') {
      const buffer = new Uint8Array(await res.arrayBuffer())
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < buffer.length; i += chunk) {
        binary += String.fromCharCode(...buffer.subarray(i, i + chunk))
      }
      return { status: res.status, text: '', base64: btoa(binary) }
    }
    if (a.want === 'none') return { status: res.status, text: '', base64: '' }
    return { status: res.status, text: await res.text(), base64: '' }
  }, args)
}

export function pageApi(page: PageLike, options: ApiOptions): ApiLike {
  const resolve = (url: string) => new URL(url, `${options.base}/`).href

  const headersFor = (url: string, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { ...extra }
    if (options.token && new URL(url).pathname.startsWith('/api/workflow/')) {
      headers['X-API-Key'] = options.token
    }
    return headers
  }

  return {
    async json(url, init) {
      const target = resolve(url)
      const hasBody = init?.body !== undefined
      const res = await inPageFetch(page, {
        url: target,
        method: init?.method ?? 'GET',
        headers: headersFor(target, hasBody ? { 'content-type': 'application/json' } : {}),
        body: hasBody ? JSON.stringify(init?.body) : null,
        bytes: null,
        want: 'json',
      })
      let body: unknown = res.text
      try {
        body = res.text === '' ? null : JSON.parse(res.text)
      } catch {
        /* a non-JSON body (an SPA fallback, a proxy error page) reaches the caller as text */
      }
      return { status: res.status, body }
    },

    async text(url) {
      const target = resolve(url)
      const res = await inPageFetch(page, {
        url: target,
        method: 'GET',
        headers: headersFor(target),
        body: null,
        bytes: null,
        want: 'text',
      })
      return { status: res.status, body: res.text }
    },

    async bytes(url) {
      const target = resolve(url)
      const res = await inPageFetch(page, {
        url: target,
        method: 'GET',
        headers: headersFor(target),
        body: null,
        bytes: null,
        want: 'bytes',
      })
      return { status: res.status, bytes: new Uint8Array(Buffer.from(res.base64, 'base64')) }
    },

    async put(url, bytes, contentType) {
      const target = resolve(url)
      const res = await inPageFetch(page, {
        url: target,
        method: 'PUT',
        // No `X-API-Key`: `uploadUrl` is a bucket, and a stray auth header on a
        // presigned PUT is how a CORS preflight starts failing.
        headers: contentType ? { 'content-type': contentType } : {},
        body: null,
        bytes: Buffer.from(bytes).toString('base64'),
        want: 'none',
      })
      return { status: res.status }
    },
  }
}
