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
  /** Bad argv, an unreadable `--inputs`, or a login the harness refused. */
  USAGE: 2,
  /** The page refused the start: `status: 'invalid'` (bad values, bad `inputs`, no such workflow, discovery). */
  INVALID: 3,
  /** The driver gave up waiting — the run may well still be going. */
  TIMEOUT: 4,
  /** SIGINT: Cancel was clicked and the run ended `cancelled`. */
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
