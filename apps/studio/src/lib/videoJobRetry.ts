/**
 * Graceful degradation for CE's `FFMPEG_BUSY` (spec P7). The Remote executor
 * has an in-flight fuse (FFMPEG_REMOTE_MAX_INFLIGHT, default 8) and the Cloud
 * Run front door can answer 429/503 under a burst; both surface as a job whose
 * error carries `FFMPEG_BUSY`. That is a queue-full signal, not a failure —
 * so a video job that fails busy is re-enqueued after a backoff instead of
 * halting the run. Anything else rethrows untouched (no silent downgrade —
 * product decision 2026-08-12).
 *
 * The classifier is inert until CE exposes failed-step codes to the rules'
 * check functions (ce#662): until then job rows say only "Server slice failed"
 * and never match. The rules are already written to carry the code the day CE
 * provides it (see `.bffless/proxy-rules/studio/rules/api/video/*\/post/check.fn.js`).
 */

/** 4 attempts total: fail → 15 s → fail → 30 s → fail → 60 s → last try. */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000]

export function isTransientVideoJobError(message: string): boolean {
  return /FFMPEG_BUSY/.test(message)
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function withBusyRetry<T>(
  attempt: () => Promise<T>,
  opts: {
    delays?: readonly number[]
    sleep?: (ms: number) => Promise<void>
    onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void
  } = {},
): Promise<T> {
  const delays = opts.delays ?? BUSY_RETRY_DELAYS_MS
  const sleep = opts.sleep ?? realSleep
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (e) {
      // Convert for the classifier/onRetry only — the THROWN value must stay the
      // original rejection (RTK Query's serialized error objects, plain strings,
      // …) or callers see a useless "[object Object]" Error instead of the real
      // shape (e.g. `{ status, data }`).
      const error = e instanceof Error ? e : new Error(String(e))
      if (i >= delays.length || !isTransientVideoJobError(error.message)) throw e
      const delayMs = delays[i]
      opts.onRetry?.({ attempt: i + 1, delayMs, error })
      await sleep(delayMs)
    }
  }
}
