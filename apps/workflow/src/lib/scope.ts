/**
 * The "All runs" toggle (spec 11 §What the person sees): view state that must
 * reach every request, so it lives here, not only in Redux.
 *
 * A run belongs to the person who started it (D26), and a project owner or
 * admin sees the rest only once they **ask** (D27). The ask travels two ways:
 * `?scope=all` on the list, which the list rule reads, and the
 * `x-workflow-scope` header on everything else — every single-run rule and
 * every file rule — because none of those has a `scope` parameter of its own
 * to put it on (the island's `files/sign` call posts no body field for it at
 * all).
 *
 * Which means the toggle has to be readable **synchronously, outside React**:
 * `http.ts` and `fetchBaseQuery`'s `prepareHeaders` both build headers where
 * no `useSelector` is available. `localStorage` is the store, exactly as
 * `values/rawPreference.ts` keeps Show raw — and, like it, storage is a best
 * effort: a browser that refuses (private mode, a quota, a sandboxed frame)
 * reads as "mine", which widens nothing. Redux mirrors the value so the
 * checkbox re-renders; this module is the source of truth for the wire.
 */
export type RunsScope = 'mine' | 'all'

/** How a caller asks for all-scope where there is no query string to put it on (mirrors `mcp/runGate`). */
export const SCOPE_HEADER = 'x-workflow-scope'

const KEY = 'workflow.runsScope'

/** The scope this browser last asked for; `'mine'` for anything this module did not write. */
export function readScope(): RunsScope {
  try {
    return window.localStorage.getItem(KEY) === 'all' ? 'all' : 'mine'
  } catch {
    // No storage to read — the safe answer is the narrow one.
    return 'mine'
  }
}

/** Remember the ask. Silently a no-op where storage refuses: the toggle still holds for this tab. */
export function writeScope(scope: RunsScope): void {
  try {
    window.localStorage.setItem(KEY, scope)
  } catch {
    // Nowhere to remember it.
  }
}

/** `{ 'x-workflow-scope': 'all' }` while widened, else `{}` — spread into every /api/workflow and /api/uploads request. */
export function scopeHeaders(): Record<string, string> {
  return readScope() === 'all' ? { [SCOPE_HEADER]: 'all' } : {}
}

/**
 * Is this the **project** role that may widen the scope (spec 11 §Why
 * `projectRole`)? Re-exported from the gate itself rather than restated, so
 * the answer the SPA renders the toggle from and the answer the rule takes
 * cannot drift: the affordance is a mirror of the gate, never a second policy.
 */
export { isAllScopeRole } from '../mcp/runGate'
