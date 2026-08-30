/**
 * Registration retry (06): `files/register` is one HTTP call per file, and a
 * step whose pipeline returns a long file list makes that many of them —
 * Studio's blog `frames` step registers every still it captured, ~170 for a
 * post with a dozen images. Under that burst the backend answered two of them
 * `500` while every other one landed and every object was already in the
 * bucket (apps#490). One transient failure must not fail the step.
 *
 * Pure (spec 09): the delay is the runner's injected `clock.sleep`, so tests
 * and the app share this file and only the clock differs.
 */
import type { FileRef } from './types'

/** `files/register` did not answer 2xx. `status` is what it did answer. */
export class RegisterFileError extends Error {
  path: string
  status: number

  constructor(path: string, status: number) {
    super(`registerFile ${path}: files/register answered ${status}`)
    this.path = path
    this.status = status
  }
}

/**
 * Backoff between attempts, in order — the ladder is short on purpose: a
 * registration is cheap and the burst it is riding out is seconds long, and a
 * list of N files pays each of these up to N times in the worst case.
 */
export const REGISTER_RETRY_DELAYS_MS: readonly number[] = [500, 1500]

/**
 * Is this failure worth asking again? A 5xx and a network failure (fetch threw,
 * so there is no status at all) are the server or the wire having a moment. A
 * 4xx is the request being wrong — an out-of-prefix key, a missing object — and
 * the same request will be wrong again.
 */
export function isTransientRegisterFailure(err: unknown): boolean {
  if (err instanceof RegisterFileError) return err.status >= 500
  return true
}

/**
 * Wrap a `register(path)` with the retry policy above: up to
 * `REGISTER_RETRY_DELAYS_MS.length` extra attempts on a transient failure,
 * sleeping the ladder between them; the last error is rethrown as-is. `signal`
 * reaches the sleep so a cancelled run does not sit out a backoff.
 */
export function withRegisterRetry(
  register: (path: string) => Promise<FileRef>,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): (path: string) => Promise<FileRef> {
  return async (path) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await register(path)
      } catch (err) {
        const delay = REGISTER_RETRY_DELAYS_MS[attempt]
        if (delay === undefined || !isTransientRegisterFailure(err)) throw err
        await sleep(delay, signal)
      }
    }
  }
}
