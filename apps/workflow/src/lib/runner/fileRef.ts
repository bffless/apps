/**
 * The one File-ref shape check, below the purity fence so everything can share
 * it: `lib/runner/**` may not import from `components/**` (spec 09), so a guard
 * that lives above the fence has to be copied to be used below it — and it was,
 * three times over (`inputConstraints.optionValue`, the `form` adapter's
 * `isFileRefLike`, and `components/values/fileRef`'s `isFileRef`, which now
 * re-exports this one).
 *
 * "Like" is the loose reading, and deliberately so: a File ref *names* a file
 * with `path`/`name`/`url`, which is all an option list, a membership check or
 * a card needs to decide "this is a file, not a plain value". The strict
 * reading — the full `FileRef` including `contentType`/`size` — belongs to the
 * type vocabulary (`outputs.ts`'s `isFileRef`, which builds on this one), since
 * that is the shape a `type: file` output promises downstream.
 */
import type { FileRef } from './types'

export function isFileRefLike(value: unknown): value is FileRef {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.path === 'string' && typeof v.name === 'string' && typeof v.url === 'string'
}
