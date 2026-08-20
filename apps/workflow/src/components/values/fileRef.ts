/**
 * A `file`-declared value only needs to actually look like a File ref before
 * FileCard trusts it: the dispatch site (`ValueView`) can't verify an
 * `unknown` value with a type cast alone. `contentType`/`size` are checked
 * separately, defensively, inside FileCard, since a value can satisfy this
 * guard while still missing them (a bare `path` string is also valid per 02
 * and is handled by the caller, not this guard).
 */
import type { FileRef } from '../../lib/runner/types'

export function isFileRef(value: unknown): value is FileRef {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.path === 'string' && typeof v.name === 'string' && typeof v.url === 'string'
}
