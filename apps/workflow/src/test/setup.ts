import '@testing-library/jest-dom'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { forgetProjectRepository } from '../lib/discovery'
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
 * …and jsdom has no canvas backend either: `getContext('2d')` answers `null`,
 * which `uplot` dereferences one microtask later (`_commit` → `clearRect`).
 * That lands as an *uncaught* exception rather than a test failure, so any
 * suite that renders a `render: chart` output — anything showing the hello
 * bundle's interactive workflow, since its `counts` output gained one in
 * Task 21 — fails the whole run while reporting every test as passing.
 *
 * The two stubs below are deliberately inert: nothing asserts what a canvas
 * drew. The chart is only ever really exercised in a browser (e2e), and
 * `ChartView.test.tsx` mocks the `uplot` module outright and asserts the
 * *computed series* instead. Their one job is to let uPlot's draw path run to
 * completion without a null deref.
 */
if (typeof globalThis.Path2D === 'undefined') {
  // uPlot builds its line/bar paths as `Path2D` objects before stroking them.
  globalThis.Path2D = class Path2DStub {
    addPath() {}
    arc() {}
    arcTo() {}
    bezierCurveTo() {}
    closePath() {}
    ellipse() {}
    lineTo() {}
    moveTo() {}
    quadraticCurveTo() {}
    rect() {}
    roundRect() {}
  } as unknown as typeof Path2D
}

if (typeof HTMLCanvasElement !== 'undefined') {
  // Every drawing call is a no-op; the handful of getters that must answer an
  // object (rather than `undefined`) answer the emptiest honest one.
  const noop = () => {}
  const context = (canvas: HTMLCanvasElement) =>
    new Proxy({ canvas } as Record<string | symbol, unknown>, {
      get(target, prop) {
        if (prop in target) return target[prop]
        if (prop === 'measureText') return () => ({ width: 0 })
        if (prop === 'createLinearGradient' || prop === 'createPattern')
          return () => ({ addColorStop: noop })
        if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
        return noop
      },
      set(target, prop, value) {
        target[prop] = value
        return true
      },
    })
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return context(this)
  } as unknown as HTMLCanvasElement['getContext']
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
  // Same for the serving-project memo (lib/discovery, apps#363): one test's
  // runtime answer must never scope the next test's discovery.
  forgetProjectRepository()
})

afterAll(() => {
  server.close()
  globalThis.Request = RealRequest
  globalThis.fetch = realFetch
})
