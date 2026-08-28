/**
 * The browser capabilities every `IslandHost` needs, in one place, because two
 * very different callers build a host: the runner middleware (a step's island)
 * and `IslandView` (a `render: island` viewer). Neither should have its own
 * idea of how the harness fetches a bundle file, opens a link, or signs an
 * object for the frame to load.
 *
 * `credentials: 'same-origin'` is the whole point of the harness doing the
 * fetch: the island's own frame has an opaque origin and could not send the
 * member's session cookie itself (Decision 9).
 */
import type { HttpJson } from '../lib/runner/adapters/pipeline'

export async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, { credentials: 'same-origin' })
  // A non-2xx body is still read: the host reports the status, and a bundle
  // server's error page is occasionally the only clue about why.
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

/**
 * `ui/open-link`. Already `isSafeUrl`-gated by the host, and opened with
 * `noopener` so the new tab cannot reach back into the harness through
 * `window.opener`.
 */
export function openLink(url: string): void {
  globalThis.open?.(url, '_blank', 'noopener')
}

// ---------------------------------------------------------------------------
// workflow.sign (Decision 6)
// ---------------------------------------------------------------------------

/**
 * Verbatim the `files/sign` rule's 400 body, so a path this gate stops and a
 * path the rule stops read the same to the island — the client check is only
 * an early copy of the server's, never a second, differently-worded contract.
 */
const NOT_CONFINED = 'path must be an uploads-relative key under workflows/ with no traversal'

/** The `expiresIn` the rule mints, and what a body that omits it is read as. */
const DEFAULT_EXPIRES_IN = 3600

/**
 * The `files/sign` rule's own confinement, applied before the request rather
 * than after it. Deliberately the *narrower* half: the rule additionally
 * normalises a leading `/` and an `/api/uploads/` prefix away, but every path
 * the harness itself hands an island is already an uploads-relative File-ref
 * `path`, so anything else is a bug worth refusing at the call site. The rule
 * remains the authority — this only saves a round trip and gives the island a
 * message instead of a status.
 */
function confined(path: string): boolean {
  return path.startsWith('workflows/') && !path.includes('..') && !path.includes('//')
}

function errorOf(body: unknown): string | undefined {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const message = record.error ?? record.message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/**
 * `workflow.sign`: exchange an object's uploads-relative path for a presigned
 * GET the sandboxed frame can put in an `<img>`/`<video>` (Decision 6). The
 * frame has an opaque origin and no cookie, so the harness — which does — has
 * to ask the rule on its behalf.
 *
 * Built once, from the caller's `http`, because both host builders need it: a
 * step's island *and* a `render: island` viewer showing media. Rejects rather
 * than returning an error shape — `IslandHost` turns a rejection into the MCP
 * tool error the island reads, which is the only vocabulary it has.
 */
export function signFile(
  http: HttpJson,
): (path: string, signal?: AbortSignal) => Promise<{ url: string; expiresIn: number }> {
  return async (path, signal) => {
    if (!confined(path)) throw new Error(NOT_CONFINED)

    const res = await http('/api/workflow/files/sign', { method: 'POST', body: { path }, signal })
    if (!res.ok) throw new Error(errorOf(res.body) ?? `sign failed with status ${res.status}`)

    const body = res.body !== null && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : {}
    const url = typeof body.url === 'string' ? body.url : ''
    if (url === '') throw new Error(`${path}: the sign rule returned no url`)
    // The rule always sends one; the fallback is the rule's own hour rather
    // than `0`, which an island would read as "already expired" and could
    // reasonably refuse to render.
    return { url, expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : DEFAULT_EXPIRES_IN }
  }
}
