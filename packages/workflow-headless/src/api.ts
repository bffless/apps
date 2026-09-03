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
import { DriverError, EXIT } from './errors.js'
import type { PageLike } from './page.js'

export interface JsonResponse {
  status: number
  body: unknown
}

export interface ApiLike {
  json(url: string, init?: { method?: string; body?: unknown }): Promise<JsonResponse>
  text(url: string): Promise<{ status: number; body: string }>
  bytes(url: string): Promise<{ status: number; bytes: Uint8Array }>
  /**
   * The direct-to-bucket PUT. `status: 0` means the request never got a
   * response at all — a CORS refusal or a dead host — and `error` carries what
   * the browser said. The caller turns that into a diagnosis; it is not an
   * HTTP status and must never be compared as one.
   */
  put(
    url: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ status: number; error?: string }>
}

export interface ApiOptions {
  /** The harness origin every relative url resolves against. */
  base: string
  /**
   * `WORKFLOW_TOKEN`, sent as `X-API-Key` on `/api/workflow/*` **GETs** only
   * (07): an optional extra on top of the session, never a replacement for it.
   *
   * GET-only is identity-correctness, not tidiness. A CE API key is pinned to
   * role `user` by `api-key.guard` no matter who owns it, so a write that
   * carries both a session cookie and a key can resolve to a *different*
   * identity than the member who logged in — a `files/prepare` or
   * `files/register` POST attributed to the key rather than to the run's
   * owner. Reads are safe to widen; writes are not.
   */
  token?: string
  /**
   * `WORKFLOW_APP_TOKEN`, sent as `Authorization: Bearer` on **every**
   * `/api/workflow/*` call, reads and writes alike (spec 10, D23 rung 2): an
   * app token *is* the member, narrowed by its scopes, so the identity
   * mismatch that keeps `token` to GETs does not arise. Wins over `token` on
   * the calls both would touch. The browser login stays the relay's — a token
   * cannot mint a SuperTokens session, and a private deployment's document
   * load carries no header — so this is the driver's own calls, not the page's.
   */
  appToken?: string
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
  /**
   * `include` for the harness's own API (the session cookie is the
   * credential); `same-origin` for the direct-to-bucket PUT, which is exactly
   * what the harness's own upload does — a plain `XMLHttpRequest` with
   * `withCredentials` left at its default. `include` cross-origin additionally
   * requires the bucket to answer `Access-Control-Allow-Credentials: true`
   * with a non-wildcard origin, which typical S3/GCS CORS configs do not set:
   * the driver's PUT would be blocked where the identical PUT from the UI
   * succeeds, and harness cookies would be sent to the storage origin.
   */
  credentials: 'include' | 'same-origin'
}

interface FetchResult {
  status: number
  text: string
  base64: string
  /** Non-null when the request never produced a response (CORS, DNS, refused). */
  error: string | null
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

    let res: Response
    try {
      res = await fetch(a.url, {
        method: a.method,
        headers: a.headers,
        credentials: a.credentials,
        ...(body === undefined ? {} : { body }),
      })
    } catch (failure) {
      // A `fetch` that rejects produced no response at all. Reported rather
      // than thrown so the Node side can say *which* call it was and what that
      // usually means, instead of surfacing a bare `page.evaluate` stack.
      const message = failure instanceof Error ? failure.message : String(failure)
      return { status: 0, text: '', base64: '', error: message }
    }

    if (a.want === 'bytes') {
      const buffer = new Uint8Array(await res.arrayBuffer())
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < buffer.length; i += chunk) {
        binary += String.fromCharCode(...buffer.subarray(i, i + chunk))
      }
      return { status: res.status, text: '', base64: btoa(binary), error: null }
    }
    if (a.want === 'none') return { status: res.status, text: '', base64: '', error: null }
    return { status: res.status, text: await res.text(), base64: '', error: null }
  }, args)
}

export function pageApi(page: PageLike, options: ApiOptions): ApiLike {
  const resolve = (url: string) => new URL(url, `${options.base}/`).href

  const headersFor = (url: string, method: string, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { ...extra }
    const harnessApi = new URL(url).pathname.startsWith('/api/workflow/')
    if (options.appToken && harnessApi) {
      headers.Authorization = `Bearer ${options.appToken}`
    } else if (options.token && method === 'GET' && harnessApi) {
      headers['X-API-Key'] = options.token
    }
    return headers
  }

  /**
   * A request that never reached the harness is a *driver* failure, not an
   * answer — `errors.ts`'s rule is that it must never look like a run that
   * ran and failed, so it leaves as a `DriverError` rather than as a status
   * some caller might treat as a soft 404.
   */
  const orThrow = (res: FetchResult, url: string): FetchResult => {
    if (res.error === null) return res
    throw new DriverError(`could not reach ${url}: ${res.error}`, EXIT.USAGE)
  }

  return {
    async json(url, init) {
      const target = resolve(url)
      const hasBody = init?.body !== undefined
      const method = init?.method ?? 'GET'
      const res = orThrow(
        await inPageFetch(page, {
          url: target,
          method,
          headers: headersFor(target, method, hasBody ? { 'content-type': 'application/json' } : {}),
          body: hasBody ? JSON.stringify(init?.body) : null,
          bytes: null,
          want: 'json',
          credentials: 'include',
        }),
        target,
      )
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
      const res = orThrow(
        await inPageFetch(page, {
          url: target,
          method: 'GET',
          headers: headersFor(target, 'GET'),
          body: null,
          bytes: null,
          want: 'text',
          credentials: 'include',
        }),
        target,
      )
      return { status: res.status, body: res.text }
    },

    async bytes(url) {
      const target = resolve(url)
      const res = orThrow(
        await inPageFetch(page, {
          url: target,
          method: 'GET',
          headers: headersFor(target, 'GET'),
          body: null,
          bytes: null,
          want: 'bytes',
          credentials: 'include',
        }),
        target,
      )
      return { status: res.status, bytes: new Uint8Array(Buffer.from(res.base64, 'base64')) }
    },

    async put(url, bytes, contentType) {
      const target = resolve(url)
      const res = await inPageFetch(page, {
        url: target,
        method: 'PUT',
        // No `X-API-Key`: `uploadUrl` is a bucket, and a stray auth header on a
        // presigned PUT is how a CORS preflight starts failing. `credentials`
        // gets the same treatment, for the same reason — see FetchArgs.
        headers: contentType ? { 'content-type': contentType } : {},
        body: null,
        bytes: Buffer.from(bytes).toString('base64'),
        want: 'none',
        credentials: 'same-origin',
      })
      // Not `orThrow`: a PUT that never got a response has a much more useful
      // diagnosis than "could not reach", and `uploadOne` is where it is known.
      return { status: res.status, ...(res.error === null ? {} : { error: res.error }) }
    },
  }
}
