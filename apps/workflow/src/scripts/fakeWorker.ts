/**
 * The Worker side of the script RPC, for unit tests.
 *
 * Unlike `islands/fakeIsland.ts` — which drives the *real* ext-apps `App` over
 * an in-memory transport — there is no real counterpart to run here: the
 * Worker half is the shim text, and jsdom has neither `Worker` nor
 * `URL.createObjectURL`. So this is a **scripted** double: a test says what the
 * worker posts back for each message it receives (`run`, `rpc:res`, `abort`)
 * and the fake records everything the host sent it, including the transfer
 * list. The shim text itself is proven by `rpc.test.ts` (it parses, and it has
 * no static imports) and by the real-browser check in the task report.
 *
 * Replies are queued as microtasks, never posted synchronously inside
 * `postMessage`, so the ordering a test observes is the ordering a real Worker
 * would produce.
 */
import type { FromWorker, RpcResMessage, RunMessage, ToWorker, WorkerLike } from './rpc'

/** What the worker posts back for each message the host sends it. */
export interface FakeWorkerScript {
  run?: (msg: RunMessage) => FromWorker[]
  rpcRes?: (msg: RpcResMessage) => FromWorker[]
  abort?: () => FromWorker[]
}

export interface FakeWorker extends WorkerLike {
  /** Every message the host posted, in order. */
  readonly received: ToWorker[]
  /** The transfer list that came with each one (index-aligned with `received`). */
  readonly transfers: (Transferable[] | undefined)[]
  /** How many times the host called `terminate()`. */
  terminated: number
  /** Post a message to the host, as the worker would. */
  emit(msg: FromWorker): void
  /** An uncaught error inside the worker — the host's `onerror`. */
  fail(message: string): void
}

export function createFakeWorker(script: FakeWorkerScript = {}): FakeWorker {
  const received: ToWorker[] = []
  const transfers: (Transferable[] | undefined)[] = []

  const worker: FakeWorker = {
    received,
    transfers,
    terminated: 0,
    onmessage: null,
    onerror: null,

    postMessage(message, transfer) {
      const msg = message as ToWorker
      received.push(msg)
      transfers.push(transfer)

      const replies =
        msg.t === 'run'
          ? script.run?.(msg)
          : msg.t === 'rpc:res'
            ? script.rpcRes?.(msg)
            : script.abort?.()

      for (const reply of replies ?? []) {
        queueMicrotask(() => worker.emit(reply))
      }
    },

    terminate() {
      worker.terminated += 1
    },

    emit(msg) {
      worker.onmessage?.(new MessageEvent('message', { data: msg }))
    },

    fail(message) {
      worker.onerror?.(new ErrorEvent('error', { message }))
    },
  }

  return worker
}
