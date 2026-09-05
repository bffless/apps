/**
 * A workflow's id from its file name — `interactive.workflow.yaml` →
 * `interactive`, `long-to-short.yaml` → `long-to-short` — the page's
 * `workflowId` (`lib/coerce.ts`) restated, because the bundle may not import
 * that module (the fence) and `ids.test.ts` holds the two equal.
 */
export function workflowId(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.replace(/\.workflow\.ya?ml$/i, '').replace(/\.ya?ml$/i, '')
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** `run_` + 26 Crockford-base32 characters — `lib/autoStart.ts`'s, restated for the bundle. */
export const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * `lib/runner/ids.ts`'s ULID restated for the bundle (no `crypto` in CE's
 * sandbox): 10 time chars + 16 random. An id, not a secret — the run it names
 * is authorised by the caller's own credential on every call that touches it,
 * so the only property that matters here is that two ids minted in the same
 * millisecond differ. Minting it *here* rather than in the driver is what lets
 * `workflow.start` answer the caller an id it can poll immediately (ADR-0006),
 * a minute before the dispatched job writes the run's first row.
 */
export function mintRunId(now: number, random: () => number = Math.random): string {
  let time = '',
    t = now
  for (let i = 0; i < 10; i++) {
    const mod = t % 32
    time = CROCKFORD[mod] + time
    t = (t - mod) / 32
  }
  let rand = ''
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(random() * 32)]
  return `run_${time}${rand}`
}

/**
 * The ms timestamp a run id carries, or `null` for anything that is not one —
 * how `workflow.status` tells a just-dispatched run (no row yet, but minted
 * moments ago) from an id that never named a run at all.
 */
export function runIdTime(runId: string): number | null {
  if (!RUN_ID_PATTERN.test(runId)) return null
  let t = 0
  for (const ch of runId.slice(4, 14)) t = t * 32 + CROCKFORD.indexOf(ch)
  return t
}
