const DURATION_PATTERN = /^([0-9]+)(ms|s|m|h)$/

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** Parses a workflow duration literal (e.g. `2s`, `10m`, `1h`) into milliseconds. */
export function parseDuration(s: string): number {
  const match = DURATION_PATTERN.exec(s)
  if (!match) throw new RangeError(`invalid duration: ${JSON.stringify(s)} (expected /${DURATION_PATTERN.source}/)`)
  const [, amount, unit] = match
  return Number(amount) * UNIT_MS[unit!]!
}
