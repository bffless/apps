/**
 * The app-side IO half of the `{"$file"}` payload story (Task 12/13).
 *
 * `lib/runner/payload.ts` stays pure: `hydrateOutputs` knows *which* values to
 * replace, never how to reach the bytes. This module is the `fetchJson` it is
 * handed on the read path (`store/workflowApi.ts`'s `getRun`) — a plain
 * same-origin GET of the ref's serve url, which is CE's `file_serve_handler`
 * route (`/api/uploads/…`, see `coerce.ts`'s `fileUrl`) — and nothing else:
 * `lib/url`'s `isServeUrl` refuses any other url outright.
 *
 * It **never rejects.** A run record is read to be *looked at*: one payload
 * that 404s, 500s or was garbage-collected out of the bucket must not turn the
 * whole run page into "couldn't load this run". So a failure resolves to the
 * `{ $file, $error }` sentinel instead, which `hydrateOutputs` substitutes just
 * like any other value and `ValueView` renders as a "payload unavailable" chip
 * that still offers the bytes. That also keeps `hydrateOutputs` free to reject
 * on a genuinely throwing fetcher — this one simply never is.
 */
import { isUnavailablePayload } from './runner/payload'
import type { UnavailablePayload } from './runner/payload'
import type { FileRef } from './runner/types'
import { isServeUrl } from './url'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function unavailable(ref: FileRef, error: string): UnavailablePayload {
  return { $file: ref, $error: error }
}

/** Fetch the JSON a `{ $file }` payload points to, or the sentinel saying why not. */
export async function fetchPayload(ref: FileRef): Promise<unknown> {
  // The ref comes off a run row any authenticated member can write, so the url
  // is gated to the file-serve route before it is fetched with their cookie —
  // the same rule a `script` step's `ctx.files.fetch` is held to.
  if (!isServeUrl(ref.url)) return unavailable(ref, 'url refused')
  try {
    const res = await fetch(ref.url, { credentials: 'same-origin' })
    if (!res.ok) return unavailable(ref, `the payload request answered ${res.status}`)
    return await res.json()
  } catch (err) {
    return unavailable(ref, messageOf(err))
  }
}

/**
 * The read memo (apps#375). `workflowApi.getRun` hydrates every `{"$file"}`
 * on every read, and a run page in flight polls that read every 5 s — so
 * without this, a viewer watching a run whose early steps offloaded pulled
 * every one of those payloads again on each tick. A payload is immutable once
 * written (its path is unique per step attempt, 06), so the memo is keyed by
 * `ref.path` and holds the *promise*: concurrent reads of one path share one
 * request. A failure is never remembered — the sentinel resolves, but the
 * entry is dropped, so the next poll (or a Retry) tries the bucket again.
 *
 * Module-level on purpose: the store's `getRun` is the only caller, and it
 * calls `forgetPayloads()` whenever the run it reads changes, which bounds
 * the memo to one run's worth of payloads.
 */
const memo = new Map<string, Promise<unknown>>()

export function fetchPayloadCached(ref: FileRef): Promise<unknown> {
  const hit = memo.get(ref.path)
  if (hit) return hit
  const pending = fetchPayload(ref).then((value) => {
    if (isUnavailablePayload(value)) memo.delete(ref.path)
    return value
  })
  memo.set(ref.path, pending)
  return pending
}

/** Drop every memoized payload — the run being read changed, or a test ended. */
export function forgetPayloads(): void {
  memo.clear()
}
