/**
 * Master switch for the MSW dev worker. When off, the worker never registers and
 * any worker a previous session left behind is torn down — so `/api/*` and
 * `/_bffless/*` go straight to the network with **single** Network rows and no
 * service-worker layer at all. Handy for ruling the worker out when an upstream
 * error (e.g. an edge 502) is in play.
 *
 * Resolution (first match wins), dev-only:
 *   1. `?mocks=on` / `?mocks=off` in the URL — persisted to localStorage so it
 *      sticks across reloads (drop the query string and it stays put).
 *   2. a `mocks` value persisted by a previous override.
 *   3. `VITE_MOCKS=false` in the env.
 *   4. default: on.
 *
 * This is independent of `MOCK_STUDIO` in `handlers.ts` (which only decides
 * whether the *studio* handlers are mocked vs. passed through). If this master
 * switch is off, the worker isn't running, so nothing is mocked regardless.
 */
const KEY = 'mocks'

function resolveMocksEnabled(): boolean {
  if (typeof window === 'undefined') return false
  const override = new URLSearchParams(window.location.search).get(KEY)
  if (override === 'on' || override === 'off') {
    window.localStorage.setItem(KEY, override)
  }
  const stored = window.localStorage.getItem(KEY)
  if (stored === 'off') return false
  if (stored === 'on') return true
  return (import.meta.env as Record<string, string | undefined>).VITE_MOCKS !== 'false'
}

export const MOCKS_ENABLED = resolveMocksEnabled()
