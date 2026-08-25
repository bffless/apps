/**
 * The `{"$file"}` payload module (Task 12): offloading an oversized output
 * value to storage at persist time, and hydrating it back on read.
 *
 * A `step.succeeded`/`run.finished` output is JSON — `outputs`/`table`/`json`
 * declared values (02) — and some of those are large (a script's returned
 * table, a big `json`-typed value). `trimResponse` (results.ts) already caps
 * a step's raw `response` at 256 KB by *stubbing* it with a `{ note:
 * 'truncated', size }` marker that is never read back into the run — that is
 * a completely different story from this one. An `outputs` value is meant to
 * be dereferenced transparently by renderers and by later expressions
 * (`steps.<key>.outputs.<name>`), so instead of a lossy stub it is uploaded
 * whole and replaced with a real, fetchable `FileRef` under `{ $file }` — the
 * *persisted row* carries the pointer; the live Redux state always keeps the
 * inline value (expressions must stay synchronous).
 *
 * Pure: no React/Redux/MSW/store/islands/scripts imports (spec 09, enforced
 * by eslint) — IO arrives only through the injected `store`/`fetchJson`
 * functions the caller (the middleware) provides.
 */
import { isFileRef } from './outputs'
import type { FileRef } from './types'

/** Per-output persistence budget (Decision 5) — distinct from `results.ts`'s `RESPONSE_BUDGET_BYTES`, which caps a step's raw `response`, not its `outputs`. */
export const PAYLOAD_BUDGET_BYTES = 256 * 1024

export interface FilePayload {
  $file: FileRef
}

/** A plain object with exactly one own key, `$file`, holding a File ref — never a bare `FileRef` (that is a `file`-typed output's own shape, 02) and never a nested/partial match. */
export function isFilePayload(v: unknown): v is FilePayload {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const keys = Object.keys(v as Record<string, unknown>)
  return keys.length === 1 && keys[0] === '$file' && isFileRef((v as Record<string, unknown>).$file)
}

/** UTF-8 byte length of `JSON.stringify(v)` — the same measure `results.ts`'s `trimResponse` uses for `response`. */
export function byteSize(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length
}

/**
 * For each output (top level of the map only) whose `byteSize` exceeds the
 * budget: JSON-serialize it, hand it to `store` as `<name>.json`, and
 * substitute `{ $file: ref }`. Returns a **new** map — the input is
 * untouched, so the caller's live state stays inline. A nested `$file`-shaped
 * value deeper inside a kept (under-budget) output is left exactly as-is;
 * offload is decided per top-level output, not recursively.
 */
export async function offloadOutputs(
  outputs: Record<string, unknown>,
  store: (name: string, json: string) => Promise<FileRef>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...outputs }
  for (const [name, value] of Object.entries(outputs)) {
    if (byteSize(value) <= PAYLOAD_BUDGET_BYTES) continue
    const json = JSON.stringify(value)
    const ref = await store(name, json)
    out[name] = { $file: ref }
  }
  return out
}

/**
 * The read-side inverse: replace every top-level `{ $file }` with the
 * fetched JSON it points to. `null`/`undefined` pass through unchanged (an
 * absent/not-yet-finished run's `outputs`). Values nested inside a kept
 * output are never inspected — the same "top level only" rule as
 * `offloadOutputs`.
 */
export async function hydrateOutputs(
  outputs: Record<string, unknown> | null | undefined,
  fetchJson: (ref: FileRef) => Promise<unknown>,
): Promise<Record<string, unknown> | null | undefined> {
  if (outputs === null || outputs === undefined) return outputs
  const out: Record<string, unknown> = { ...outputs }
  for (const [name, value] of Object.entries(outputs)) {
    if (isFilePayload(value)) out[name] = await fetchJson(value.$file)
  }
  return out
}
