/**
 * Regression test for the RTK data-layer reauth wrapper.
 *
 * Reproduces the production bug: a long auto-build outlives the SuperTokens
 * access token, so mid-run `/api/*` calls (the job poll, the per-scene refiners,
 * the presigned uploads) start answering `401 {"message":"try refresh token"}`.
 * Without `baseQueryWithReauth` the run dies there and surfaces that string
 * verbatim in the UI. With it, the call refreshes once and retries in place.
 *
 * The single-flight assertion is the load-bearing one: SuperTokens *rotates* the
 * refresh token, so if the many concurrent calls of a build each fired their own
 * refresh, all but the first would race a rotated cookie and fail.
 *
 * Drives the real store + `studioApi` middleware with `fetch` stubbed directly
 * (rather than MSW) — `fetchBaseQuery` calls the global `fetch`, so the stub
 * exercises the whole baseQuery path including the reauth wrapper.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { studioApi } from './studioApi'
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
const JOB = 'GET /api/studio/job'

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
    reducer: { [studioApi.reducerPath]: studioApi.reducer },
    middleware: (gdm) => gdm().concat(studioApi.middleware),
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
  it('refreshes and retries when an expired token 401s mid-build', async () => {
    let jobHits = 0
    const calls = mockFetch({
      [JOB]: () => {
        jobHits += 1
        // First read is the expired-token 401 the proxy middleware sends.
        return jobHits === 1
          ? json(401, { message: 'try refresh token' })
          : json(200, { status: 'done', kind: 'scenes', result: { scenes: [] } })
      },
      [REFRESH]: () => new Response(null, { status: 200 }),
    })

    const store = makeStore()
    const res = await store.dispatch(studioApi.endpoints.getStudioJob.initiate('job-1'))

    expect(res.error).toBeUndefined()
    expect(res.data).toMatchObject({ status: 'done' })
    expect(calls).toEqual([JOB, REFRESH, JOB])
  })

  it('issues exactly one refresh for many concurrent 401s', async () => {
    const calls = mockFetch({
      [JOB]: () => json(401, { message: 'try refresh token' }),
      [REFRESH]: () => new Response(null, { status: 200 }),
    })

    const store = makeStore()
    // Five distinct job ids so RTK Query doesn't dedupe them into one request.
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((id) =>
        store.dispatch(studioApi.endpoints.getStudioJob.initiate(id)),
      ),
    )

    // The refresh keeps "succeeding" but the job keeps 401ing, so each call
    // retries once and gives up. What matters: one refresh, not five.
    expect(calls.filter((c) => c === REFRESH)).toHaveLength(1)
  })

  it('surfaces the 401 when the refresh itself fails (session truly gone)', async () => {
    const calls = mockFetch({
      [JOB]: () => json(401, { message: 'try refresh token' }),
      [REFRESH]: () => new Response(null, { status: 401 }),
      'POST /_bffless/auth/refresh': () => new Response(null, { status: 401 }),
    })

    const store = makeStore()
    const res = await store.dispatch(studioApi.endpoints.getStudioJob.initiate('job-1'))

    expect(res.error).toMatchObject({ status: 401 })
    // No retry of the job — the refresh failed, so a retry would just 401 again.
    expect(calls.filter((c) => c === JOB)).toHaveLength(1)
  })
})
