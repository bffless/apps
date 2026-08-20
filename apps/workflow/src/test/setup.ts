import '@testing-library/jest-dom'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { resetDb } from '../mocks/db'
import { server } from '../mocks/server'

/**
 * jsdom + undici parse a request URL with no base, and the app (rightly) speaks
 * in same-origin relative paths. Resolving them against the document's origin —
 * `Request` for RTK Query's `fetchBaseQuery`, `fetch` for everything else — is
 * what the browser does for free. Wrapped *after* `server.listen()` so MSW's
 * interceptor stays underneath and still sees every call.
 *
 * `location` is absent in the `node` test environment (lib/runner's pure suites
 * opt into it); those tests make no relative request, so any base will do.
 */
const ORIGIN = globalThis.location?.origin ?? 'http://localhost'
const RealRequest = globalThis.Request
const absolute = (input: RequestInfo | URL): RequestInfo | URL =>
  typeof input === 'string' && input.startsWith('/') ? ORIGIN + input : input

class BasedRequest extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(absolute(input), init)
  }
}

let realFetch: typeof globalThis.fetch

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
  globalThis.Request = BasedRequest as unknown as typeof Request
  realFetch = globalThis.fetch
  globalThis.fetch = (input, init) => realFetch(absolute(input), init)
})

afterEach(() => {
  server.resetHandlers()
  resetDb()
})

afterAll(() => {
  server.close()
  globalThis.Request = RealRequest
  globalThis.fetch = realFetch
})
