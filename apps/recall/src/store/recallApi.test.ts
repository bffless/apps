/**
 * Regression test for the RTK data-layer reauth wrapper.
 *
 * Reproduces the production bug seen in Studio: a long-running session
 * outlives the SuperTokens access token, so mid-session `/api/*` calls start
 * answering `401 {"message":"try refresh token"}`. Without `baseQueryWithReauth`
 * the call dies there and surfaces that string verbatim in the UI. With it, the
 * call refreshes once and retries in place.
 *
 * The single-flight assertion is the load-bearing one: SuperTokens *rotates*
 * the refresh token, so if several concurrent calls each fired their own
 * refresh, all but the first would race a rotated cookie and fail.
 *
 * `recallApi` ships with no endpoints of its own (they're injected by later
 * tasks), so this test injects one throwaway query endpoint to exercise the
 * shared base query — drives the real store + middleware with `fetch` stubbed
 * directly (rather than MSW), since `fetchBaseQuery` calls the global `fetch`.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { recallApi } from './recallApi'
import { __resetAuthCache } from '../lib/auth'

// fetchBaseQuery builds a `Request` from the relative `/api/...` URL; in
// jsdom+undici that needs an absolute base.
const ORIGIN = 'http://localhost:3000'
const RealRequest = globalThis.Request
class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/')) input = ORIGIN + input
    super(input, init)
  }
}
beforeAll(() => {
  globalThis.Request = BasedRequest as unknown as typeof Request
})
afterAll(() => {
  globalThis.Request = RealRequest
})

const REFRESH = 'POST /api/auth/session/refresh'
const PING = 'GET /api/recall/ping'

const testApi = recallApi.injectEndpoints({
  endpoints: (builder) => ({
    ping: builder.query<{ ok: boolean }, string>({
      query: (id) => `api/recall/ping?id=${encodeURIComponent(id)}`,
    }),
  }),
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Read method+url from whatever fetchBaseQuery hands the global fetch. */
function reqInfo(input: unknown, init?: RequestInit): { url: string; method: string } {
  if (typeof input === 'string') return { url: input, method: init?.method ?? 'GET' }
  if (input instanceof URL) return { url: input.toString(), method: init?.method ?? 'GET' }
  const r = input as Request
  return { url: r.url, method: r.method }
}

/** Stub global fetch, dispatching on `${METHOD} ${path}` and recording calls. */
function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: string[] = []
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const { url, method } = reqInfo(input, init)
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const key = `${method.toUpperCase()} ${path}`
    calls.push(key)
    const route = routes[key]
    if (!route) return json(404, { message: `no route for ${key}` })
    return route(init)
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

function makeStore() {
  return configureStore({
    reducer: { [recallApi.reducerPath]: recallApi.reducer },
    middleware: (gdm) => gdm().concat(recallApi.middleware),
  })
}

beforeEach(() => {
  __resetAuthCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('baseQueryWithReauth', () => {
  it('refreshes and retries when an expired token 401s mid-session', async () => {
    let hits = 0
    const calls = mockFetch({
      [PING]: () => {
        hits += 1
        // First read is the expired-token 401 the proxy middleware sends.
        return hits === 1
          ? json(401, { message: 'try refresh token' })
          : json(200, { ok: true })
      },
      [REFRESH]: () => new Response(null, { status: 200 }),
    })

    const store = makeStore()
    const res = await store.dispatch(testApi.endpoints.ping.initiate('p-1'))

    expect(res.error).toBeUndefined()
    expect(res.data).toMatchObject({ ok: true })
    expect(calls).toEqual([PING, REFRESH, PING])
  })

  it('issues exactly one refresh for many concurrent 401s', async () => {
    const calls = mockFetch({
      [PING]: () => json(401, { message: 'try refresh token' }),
      [REFRESH]: () => new Response(null, { status: 200 }),
    })

    const store = makeStore()
    // Five distinct ids so RTK Query doesn't dedupe them into one request.
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((id) => store.dispatch(testApi.endpoints.ping.initiate(id))),
    )

    // The refresh keeps "succeeding" but the ping keeps 401ing, so each call
    // retries once and gives up. What matters: one refresh, not five.
    expect(calls.filter((c) => c === REFRESH)).toHaveLength(1)
  })

  it('surfaces the 401 when the refresh itself fails (session truly gone)', async () => {
    const calls = mockFetch({
      [PING]: () => json(401, { message: 'try refresh token' }),
      [REFRESH]: () => new Response(null, { status: 401 }),
      'POST /_bffless/auth/refresh': () => new Response(null, { status: 401 }),
    })

    const store = makeStore()
    const res = await store.dispatch(testApi.endpoints.ping.initiate('p-1'))

    expect(res.error).toMatchObject({ status: 401 })
    // No retry of the ping — the refresh failed, so a retry would just 401 again.
    expect(calls.filter((c) => c === PING)).toHaveLength(1)
  })
})
