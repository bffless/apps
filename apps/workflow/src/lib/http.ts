/**
 * `httpJson` — the app's implementation of the `HttpJson` seam the pipeline
 * adapter (03) is written against: one same-origin JSON call, no retries, no
 * interpretation of the answer beyond parsing it.
 *
 * Everything a pipeline step talks to lives on the harness host (ADR-0001), so
 * `credentials: 'same-origin'` is enough to carry the session cookie. It does
 * NOT reauth: the 401-refresh-retry policy belongs to the layer that owns the
 * run's lifecycle (Phase 3's runtime), not to a single request.
 */
import type { HttpJson } from './runner/adapters/pipeline'

/**
 * `?a=1&b=2` for the values that survive: `undefined`/`null` are *absent*
 * parameters (not empty ones), and anything richer than a primitive is sent as
 * JSON — the shape a pipeline expects for a structured filter.
 */
export function toQueryString(query?: Record<string, unknown>): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    const primitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    params.append(key, primitive ? String(value) : JSON.stringify(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

/** JSON when the server says so, otherwise the raw text — the adapter relies on both. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!(res.headers.get('content-type') ?? '').includes('json')) return text
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const httpJson: HttpJson = async (path, init) => {
  const headers: Record<string, string> = { ...init.headers }
  let body: string | undefined
  if (init.body !== undefined) {
    body = JSON.stringify(init.body)
    headers['content-type'] = 'application/json'
  }

  const res = await fetch(`${path}${toQueryString(init.query)}`, {
    method: init.method,
    credentials: 'same-origin',
    headers,
    body,
    signal: init.signal,
  })

  // CE names the execution log it wrote for this call (apps#528): on
  // debug-enabled rules and on every execution failure with debug off. Absent
  // — not `null` — when the response carried no header, so callers can spread
  // the result without a key appearing out of nowhere.
  const logId = res.headers.get('x-pipeline-log-id')
  return { status: res.status, ok: res.ok, body: await readBody(res), ...(logId ? { logId } : {}) }
}

// ---------------------------------------------------------------------------
// Reauth (R5) — owned by the runner (Phase 3), not by `httpJson` itself.
// ---------------------------------------------------------------------------

/** SuperTokens' own refresh route, reached through the harness's `/api/auth/*` rule. */
const REFRESH_URL = '/api/auth/session/refresh'

/**
 * SuperTokens *rotates* the refresh token, so two concurrent refreshes race on
 * the same cookie: the first rotation invalidates the token the others hold. A
 * run fans out into many parallel writes/steps that can all 401 at once, so the
 * shared in-flight promise is the common path, not the edge case — the same
 * shape as `workflowApi.ts`'s read-side `baseQueryWithReauth`.
 */
let refreshInFlight: Promise<boolean> | null = null

async function requestRefresh(): Promise<boolean> {
  try {
    const res = await fetch(REFRESH_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { rid: 'session' },
    })
    return res.ok
  } catch {
    return false
  }
}

function attemptRefresh(): Promise<boolean> {
  refreshInFlight ??= requestRefresh().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

/**
 * `httpJson` wrapped with the app's 401-refresh-retry policy: a run outlives
 * the SuperTokens access token, so both the runner's write path (`runStore`)
 * and its pipeline-step calls need one reauth-and-retry, same as the read side.
 * This is what `RunnerDeps.http` is built from (Phase 3, `store/index.ts`).
 */
export const httpJsonWithReauth: HttpJson = async (path, init) => {
  const res = await httpJson(path, init)
  if (res.status !== 401) return res
  return (await attemptRefresh()) ? httpJson(path, init) : res
}
