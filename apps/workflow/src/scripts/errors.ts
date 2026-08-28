/**
 * The two failure shapes a script step can end on (03).
 *
 * They live here rather than in `ScriptHost.ts` because the host imports the
 * sandbox (`sandbox-frame.ts`) and the sandbox raises both of them: a module
 * of their own keeps that import one-way instead of a cycle. `ScriptHost.ts`
 * re-exports `ScriptError`, which stays the name the rest of the app knows.
 */

/**
 * The step failed. `code` is the module's own `err.code` where it set one, else
 * `SCRIPT` for a module that threw and `SCRIPT_LOAD` for one that could not be
 * loaded at all (non-2xx, an unreachable bundle, a sandbox that could not spawn
 * the Worker, a module with no default export). Mirrors `IslandLoadError`'s
 * shape — an `Error` carrying the `code` the step's `error` will be recorded
 * under — but the code is not fixed, so the two are not one class.
 *
 * Cancellation is deliberately *not* a `ScriptError`: an aborted run rejects
 * with a plain `AbortError`, and the caller — which knows whether it was the
 * user or `timeout-minutes` that fired — decides what that means.
 */
export class ScriptError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ScriptError'
    this.code = code
  }
}

/** An abort is not a failure — the caller distinguishes cancel from timeout. */
export function abortError(message: string): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}
