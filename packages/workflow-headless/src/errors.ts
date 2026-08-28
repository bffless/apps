/**
 * The driver's exit vocabulary (M3 Decision 13). CI reads these, so they are a
 * contract in the same sense the page's `data-testid`s are: a run that ended
 * `failed` and a driver that could not reach the harness must never look the
 * same to a workflow step's `if: failure()`.
 */
export const EXIT = {
  /** The run reached `succeeded`. */
  OK: 0,
  /** The run reached `failed` or `cancelled` — the harness ran, the work did not. */
  FAILED: 1,
  /**
   * The driver never got a run going: bad argv, an unreadable `--inputs`, a
   * login the harness refused, an upload or an API read that failed, or any
   * other driver-side fault. Deliberately *not* 1 — the rule above is that a
   * run that ended `failed` and a driver that could not reach the harness must
   * never look the same to `if: failure()`, and 1 belongs to the run.
   */
  USAGE: 2,
  /** The page refused the start: `status: 'invalid'` (bad values, bad `inputs`, no such workflow, discovery). */
  INVALID: 3,
  /** The driver gave up waiting — the run may well still be going. */
  TIMEOUT: 4,
  /**
   * SIGINT — whenever the driver is interrupted, whether or not there was a
   * run to cancel. Before the run page exists there is nothing to click, so
   * the handler closes the browser and leaves with this; once the run is up it
   * clicks Cancel and follows the run to `cancelled` first.
   */
  SIGINT: 130,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** An error that already knows which exit code it deserves. */
export class DriverError extends Error {
  readonly code: ExitCode
  /** Attached to an `invalid` refusal: the global's `errors` map, verbatim. */
  readonly details: Record<string, string> | undefined

  constructor(message: string, code: ExitCode, details?: Record<string, string>) {
    super(message)
    this.name = 'DriverError'
    this.code = code
    this.details = details
  }
}
