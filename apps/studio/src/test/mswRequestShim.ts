/**
 * Shared test helper for hook-level tests that mount a real RTK Query dispatch
 * against `msw/node` (story: server-video-ops task 6, factored out in task 7 for
 * the second consumer rather than duplicated).
 *
 * Node's global `Request`/`fetch` (unlike a browser's) have no page origin to
 * resolve a relative URL against, and every `/api/*` call in this app is
 * relative (`fetchBaseQuery({ baseUrl: '/' })` builds a bare `new
 * Request('/api/...')` before MSW even sees it; `fetchWithReauth('/api/...')`
 * does too) — so Node's `Request` throws `TypeError: Invalid URL` immediately,
 * before MSW's interceptor ever sees the call.
 */
import { vi } from 'vitest'

/**
 * Patch global `Request` so a leading-`/` string input gets `window.location.
 * origin` prefixed before delegating to the real constructor. MSW matches
 * handlers by path regardless of origin, so this is purely a URL-parsing shim,
 * not a behavior change.
 *
 * Call BEFORE `server.listen()` — MSW's interceptor reads the (now-patched)
 * global `Request` at match time. Undo with `vi.unstubAllGlobals()`.
 */
export function installMswRelativeUrlShim(): void {
  const RealRequest = globalThis.Request
  function PatchedRequest(input: RequestInfo | URL, init?: RequestInit) {
    const fixed =
      typeof input === 'string' && input.startsWith('/') ? `${window.location.origin}${input}` : input
    return new RealRequest(fixed, init)
  }
  PatchedRequest.prototype = RealRequest.prototype
  vi.stubGlobal('Request', PatchedRequest as unknown as typeof Request)
}
