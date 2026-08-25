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
 */
import type { FileRef } from '../lib/runner/types'

/** Page → Worker. */
export type ToWorker =
  | { t: 'run'; inputs: Record<string, unknown>; moduleUrl: string }
  | { t: 'abort' }
  | {
      t: 'rpc:res'
      id: number
      ok: boolean
      body?: ArrayBuffer
      headers?: [string, string][]
      status?: number
      /** Set when the page refused or could not perform the request: the shim rejects. */
      error?: string
    }

/** Worker → page. */
export type FromWorker =
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
 * jsdom has no `Worker` to inherit an `EventTarget` from.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}
