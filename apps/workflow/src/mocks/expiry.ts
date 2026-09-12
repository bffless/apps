/**
 * The mock's re-implementation of the retention stamp (spec 05 §Retention,
 * apps#686) that `runs/post`'s `expiry.fn.js` and `run/fork`'s `gate.fn.js`
 * both compute — `startedAt + keep` (epoch ms) when the definition being
 * snapshotted has a top-level `keep:` (`<n>h` | `<n>d`, the schema's `$defs.keep`
 * grammar, not `duration`), and nothing otherwise: a run without `keep:` is
 * never swept. `expiry.fn.parity.test.ts` holds the three together.
 *
 * `undefined`, not `null`, on the mock: the real rules write no column, and a
 * `toRunRow` of the stored record leaves the field absent either way.
 */
const KEEP = /^([0-9]+)(h|d)$/
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export function expiresAtOf(definition: unknown, startedAt: number): number | undefined {
  const keep =
    definition !== null && typeof definition === 'object' && !Array.isArray(definition)
      ? (definition as Record<string, unknown>).keep
      : undefined
  const m = typeof keep === 'string' ? KEEP.exec(keep) : null
  if (!m || !Number.isFinite(startedAt)) return undefined
  return startedAt + Number(m[1]) * (m[2] === 'd' ? DAY_MS : HOUR_MS)
}
