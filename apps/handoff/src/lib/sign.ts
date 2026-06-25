/**
 * Signed-URL coercion for the POST /api/sign response.
 *
 * The real backend returns `{ signed: { url, ... } }`. We also accept a flat
 * `{ url }` as a fallback (e.g. mock shapes). Never throws — any unexpected
 * input produces `null`.
 */

/**
 * Extract a usable signed URL from an unknown POST /api/sign response body.
 *
 * Resolution order:
 *   1. `raw.signed.url` — the canonical contract shape.
 *   2. `raw.url`        — flat fallback.
 *   3. `null`           — anything missing, non-string, or empty/whitespace.
 */
export function toSignedUrl(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null

  const obj = raw as Record<string, unknown>

  // 1. Prefer signed.url
  const signed = obj['signed']
  if (signed !== null && typeof signed === 'object') {
    const inner = (signed as Record<string, unknown>)['url']
    if (typeof inner === 'string') {
      const trimmed = inner.trim()
      if (trimmed.length > 0) return trimmed
      return null
    }
  }

  // 2. Fall back to top-level url
  const url = obj['url']
  if (typeof url === 'string') {
    const trimmed = url.trim()
    if (trimmed.length > 0) return trimmed
    return null
  }

  return null
}
