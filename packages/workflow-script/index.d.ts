/**
 * The `script` step module contract (spec `03-step-kinds.md`), verbatim.
 *
 * A `script` step is an ES module the harness Worker imports and calls with
 * one `ScriptContext`; its default export's return value becomes the step's
 * outputs (a `Blob`/`File` where a `file` output is declared — the runner
 * uploads it, a script never touches storage itself).
 *
 * `FileRef` here is a public copy of the harness's own `apps/workflow/src/lib/runner/types.ts`
 * `FileRef` — this package is types-only and must not import the app, so the
 * two are kept structurally identical by hand rather than shared.
 */

export interface FileRef {
  path: string
  name: string
  contentType: string
  size: number
  url: string
}

export interface ScriptContext {
  /** `with` minus `src`, evaluated; File refs as-is. */
  inputs: Record<string, unknown>
  /** Same-origin GET of a File ref's `url`. */
  files: { fetch(ref: FileRef): Promise<Response> }
  /** Shows in the step card. */
  log(msg: string): void
  annotate(
    a: { level: 'notice' | 'warning' | 'error'; message: string; title?: string } | { summary: string },
  ): void
  /**
   * Aborts on cancel / `timeout-minutes`; the Worker is terminated on the next
   * macrotask, so handlers must be synchronous and best-effort.
   */
  signal: AbortSignal
}

export type ScriptModule = {
  default: (ctx: ScriptContext) => Promise<Record<string, unknown>>
}
