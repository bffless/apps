/**
 * The app-side IO half of the `{"$file"}` payload story (Task 12/13).
 *
 * `lib/runner/payload.ts` stays pure: `hydrateOutputs` knows *which* values to
 * replace, never how to reach the bytes. This module is the `fetchJson` it is
 * handed on the read path (`store/workflowApi.ts`'s `getRun`) — a plain
 * same-origin GET of the ref's serve url, which is CE's `file_serve_handler`
 * route (`/api/uploads/…`, see `coerce.ts`'s `fileUrl`).
 *
 * It **never rejects.** A run record is read to be *looked at*: one payload
 * that 404s, 500s or was garbage-collected out of the bucket must not turn the
 * whole run page into "couldn't load this run". So a failure resolves to the
 * `{ $file, $error }` sentinel instead, which `hydrateOutputs` substitutes just
 * like any other value and `ValueView` renders as a "payload unavailable" chip
 * that still offers the bytes. That also keeps `hydrateOutputs` free to reject
 * on a genuinely throwing fetcher — this one simply never is.
 */
import type { UnavailablePayload } from './runner/payload'
import type { FileRef } from './runner/types'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function unavailable(ref: FileRef, error: string): UnavailablePayload {
  return { $file: ref, $error: error }
}

/** Fetch the JSON a `{ $file }` payload points to, or the sentinel saying why not. */
export async function fetchPayload(ref: FileRef): Promise<unknown> {
  try {
    const res = await fetch(ref.url, { credentials: 'same-origin' })
    if (!res.ok) return unavailable(ref, `the payload request answered ${res.status}`)
    return await res.json()
  } catch (err) {
    return unavailable(ref, messageOf(err))
  }
}
