/**
 * Mounts the page's tool surface (spec 10). Rendered once by `main.tsx` beside
 * `App`, inside the same `Provider` and `BrowserRouter` — App-level in every
 * sense that matters (once for the app's life, with the store and the router
 * in reach) while staying out of `App` itself, which dozens of tests mount
 * under jsdom where the polyfill's global patches have no business running.
 */
import { useWebMcp } from './useWebMcp'
import type { UseWebMcpOptions } from './useWebMcp'

export function AgentTools(props: UseWebMcpOptions = {}) {
  useWebMcp(props)
  return null
}
