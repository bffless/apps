/**
 * Human-readable byte formatting. Used by the file listing in slice #7.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * Format a byte count as a human-readable string with up to one decimal place.
 *
 * @example
 * formatBytes(0)        // "0 B"
 * formatBytes(1024)     // "1 KB"
 * formatBytes(1536)     // "1.5 KB"
 * formatBytes(1048576)  // "1 MB"
 *
 * Negative values and non-finite numbers are clamped / guarded:
 *   formatBytes(-1)       // "0 B"
 *   formatBytes(Infinity) // "—"
 *   formatBytes(NaN)      // "—"
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n <= 0) return '0 B'

  const exp = Math.min(Math.floor(Math.log2(n) / 10), UNITS.length - 1)
  const value = n / Math.pow(1024, exp)

  // Trim unnecessary trailing zero (e.g. "1.0 KB" → "1 KB").
  const formatted = value % 1 === 0 ? String(value) : value.toFixed(1)
  return `${formatted} ${UNITS[exp]}`
}

/**
 * Format an epoch-ms timestamp for the listing's "Added" column: a short
 * month/day, with the year appended when it differs from `now`'s year.
 *
 * @example formatDate(0)  // "—" (0 = unknown createdAt, see toNode)
 */
export function formatDate(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}
