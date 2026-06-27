/**
 * Regression test for the RTK data-layer reauth wrapper.
 *
 * Reproduces the production bug: on load, a logged-in user's access token is
 * expired, so `listNodes` (and friends) 401 before the session check refreshes.
 * Without `baseQueryWithReauth` those queries stay errored and the folder
 * renders empty until a manual reload. With it, the query transparently runs
 * the shared single-flight refresh and retries, recovering in place.
 *
 * Drives the real store + `handoffApi` middleware. `fetch` is stubbed directly
 * (the same approach as session.test.ts) rather than via MSW — fetchBaseQuery
 * calls the global `fetch`, so the stub exercises the whole baseQuery path.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { handoffApi } from './handoffApi'

// fetchBaseQuery builds a `Request` from the relative `/api/...` URL; in
// jsdom+undici that needs an absolute base (same shim as the other store tests).
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

type Route = (init?: RequestInit) => Response

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
function mockFetch(routes: Record<string, Route>) {
  const calls: string[] = []
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const { url, method } = reqInfo(input, init)
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const key = `${method.toUpperCase()} ${path}`
    calls.push(key)
    const route = routes[key]
    if (!route) throw new Error(`unexpected fetch: ${key}`)
    return route(init)
  })
  vi.stubGlobal('fetch', fn)
  return { calls }
}

const LIST = 'GET /api/nodes'
const ST_REFRESH = 'POST /api/auth/session/refresh'
const RELAY_REFRESH = 'POST /_bffless/auth/refresh'

function makeStore() {
  return configureStore({
    reducer: { [handoffApi.reducerPath]: handoffApi.reducer },
    middleware: (getDefault) => getDefault().concat(handoffApi.middleware),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('handoffApi baseQueryWithReauth', () => {
  beforeEach(() => vi.clearAllMocks())

  it('recovers a 401 listing by refreshing and retrying (no manual reload)', async () => {
    let authed = false
    const { calls } = mockFetch({
      [LIST]: () =>
        authed
          ? json(200, { nodes: [{ id: 'n1', name: 'file.txt', nodeType: 'file' }] })
          : new Response(null, { status: 401 }),
      [ST_REFRESH]: () => {
        authed = true
        return new Response(null, { status: 200 })
      },
    })

    const store = makeStore()
    const result = await store.dispatch(handoffApi.endpoints.listNodes.initiate({ parentId: 'root' }))

    expect(result.error).toBeUndefined()
    expect(result.data).toEqual([expect.objectContaining({ id: 'n1', name: 'file.txt', type: 'file' })])
    // 401 → one refresh → retry, in that order
    expect(calls).toEqual([LIST, ST_REFRESH, LIST])
  })

  it('surfaces the 401 when the refresh cannot recover the session', async () => {
    const { calls } = mockFetch({
      [LIST]: () => new Response(null, { status: 401 }),
      [ST_REFRESH]: () => new Response(null, { status: 401 }),
      [RELAY_REFRESH]: () => new Response(null, { status: 401 }),
    })

    const store = makeStore()
    const result = await store.dispatch(handoffApi.endpoints.listNodes.initiate({ parentId: 'root' }))

    expect(result.data).toBeUndefined()
    expect(result.error).toMatchObject({ status: 401 })
    // initial 401, both refresh paths fail, NO retry (no infinite loop)
    expect(calls).toEqual([LIST, ST_REFRESH, RELAY_REFRESH])
  })
})
