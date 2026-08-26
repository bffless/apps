import '@testing-library/jest-dom'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { forgetPayloads } from '../lib/payloadFetch'
import { resetDb } from '../mocks/db'
import { server } from '../mocks/server'

/**
 * jsdom has no `matchMedia` — `uplot` (Task 16) calls it unconditionally at
 * module load time (`setPxRatio`, unrelated to whether a chart is ever
 * constructed), so merely importing `ChartView` throws without this. Real
 * browsers always have `matchMedia`; this stub only exists for the test
 * environment. Guarded on `window` itself: `lib/runner`'s pure suites opt
 * into the `node` test environment (no `window` at all, and no `ChartView`
 * import either), so there's nothing to stub there.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

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
  // The `{"$file"}` read memo is module-level (lib/payloadFetch); a test's bucket must never answer the next test's read.
  forgetPayloads()
})

afterAll(() => {
  server.close()
  globalThis.Request = RealRequest
  globalThis.fetch = realFetch
})
