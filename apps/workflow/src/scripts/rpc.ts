/**
 * The wire between the harness page and a script step's Worker (03).
 *
 * A script module never talks to the page directly: it is imported inside a
 * shim (`worker-shim.ts`) that gives it a `ctx` whose every capability is a
 * `postMessage` away — `ctx.log`, `ctx.annotate`, and `ctx.files.fetch`, which
 * is a request/response pair (`rpc:req` → `rpc:res`) correlated by `id`
 * because the Worker has no cookies of its own and may not fetch. Keeping the
 * union in its own module means the shim text, the host and the tests all
 * quote the same shapes.
 *
 * The wire runs over a `MessageChannel`, not over the Worker's own `self`: the
 * Worker is spawned inside a sandbox frame (`sandbox-frame.ts`, Decision 4),
 * so `self` reaches the *frame*. `port` is the handover that starts it and
 * `ready` the acknowledgement that ends it; everything after those two is the
 * conversation the step is actually made of.
 */
import type { FileRef } from '../lib/runner/types'

/** Page → Worker. */
export type ToWorker =
  /**
   * The handover, and the only message that arrives on the Worker's `self`:
   * the port is the transfer, and `moduleUrl` the `data:` URL the shim will
   * `import()` when the step runs.
   */
  | { t: 'port'; moduleUrl: string }
  | { t: 'run'; inputs: Record<string, unknown> }
  | { t: 'abort' }
  | {
      t: 'rpc:res'
      id: number
      body?: ArrayBuffer
      headers?: [string, string][]
      /** Absent means 200: the shim rebuilds a `Response` from `status`, not from an `ok` flag. */
      status?: number
      /** Set when the page refused or could not perform the request: the shim rejects. */
      error?: string
    }

/** Worker → page. */
export type FromWorker =
  /** The shim has the port and the module URL — the sandbox is up. */
  | { t: 'ready' }
  | { t: 'log'; line: string }
  | { t: 'annotate'; args: unknown }
  | { t: 'rpc:req'; id: number; op: 'files.fetch'; ref: FileRef }
  | { t: 'done'; outputs: unknown }
  | { t: 'error'; code?: string; message: string }

export type RunMessage = Extract<ToWorker, { t: 'run' }>
export type RpcResMessage = Extract<ToWorker, { t: 'rpc:res' }>
export type RpcReqMessage = Extract<FromWorker, { t: 'rpc:req' }>

/**
 * The slice of `Worker` the host uses — the test seam
 * (`ScriptHostDeps.spawn`). Handler *properties* rather than
 * `addEventListener`, because there is only ever one listener per run and
 * jsdom has no `Worker` to inherit an `EventTarget` from. What the shipped
 * seam returns is not a `Worker` at all but the sandbox's port wearing this
 * shape (`sandbox-frame.ts`), which is the other reason the surface is this
 * narrow.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}
