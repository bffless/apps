/**
 * The script host (03): the IO half of a `script` step.
 *
 * A script step is an ES module from the implementation's own bundle, run in a
 * Worker. The page — not the Worker — fetches it, because the bundle is behind
 * the member's session cookie; the module text then becomes a Blob URL, and a
 * second Blob URL carries the shim (`worker-shim.ts`) the Worker is actually
 * spawned from. The shim dynamically imports the module and builds its `ctx`,
 * so every capability the module has is one this host answers over
 * `postMessage`: `ctx.log`, `ctx.annotate`, and `ctx.files.fetch` — the only
 * network any of this performs, and only ever for a url on the harness's own
 * file-serve route (`lib/url`'s `isServeUrl`): a script, like an island, may
 * not reach any other route with the member's cookies.
 *
 * This module owns the *effects*: the fetch, the two object URLs, the Worker,
 * the RPC relay, cancellation. Everything decidable from plain data — where a
 * `src` resolves to, what the module's return value must look like — lives in
 * the pure adapter (`lib/runner/adapters/script.ts`) and is imported from here,
 * the same one-way fence `islands/IslandHost.ts` keeps: `lib/runner/**` must
 * never import this file.
 */
import { resolveScriptSrc } from '../lib/runner/adapters/script'
import { isServeUrl } from '../lib/url'
import type { FileRef } from '../lib/runner/types'
import type { FromWorker, RpcReqMessage, ToWorker, WorkerLike } from './rpc'
import { SHIM_SOURCE } from './worker-shim'

/**
 * The step failed. `code` is the module's own `err.code` where it set one, else
 * `SCRIPT` for a module that threw and `SCRIPT_LOAD` for one that could not be
 * loaded at all (non-2xx, an unreachable bundle, a module with no default
 * export). Mirrors `IslandLoadError`'s shape — an `Error` carrying the `code`
 * the step's `error` will be recorded under — but the code is not fixed, so the
 * two are not one class.
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

export interface ScriptHostDeps {
  /** The module text, from `/w/<impl>/<src>` — same-origin, with cookies. */
  fetchText: (url: string) => Promise<{ ok: boolean; status: number; text: string }>
  /** The `ctx.files.fetch` relay. See `fetchBytes` below for the shipped one. */
  fetchBytes: (
    url: string,
  ) => Promise<{ ok: boolean; status: number; body: ArrayBuffer; headers: [string, string][] }>
  /** `ctx.log` — a live line on the step card. */
  onLog: (line: string) => void
  /** `ctx.annotate` — the middleware's `annotateEvent` (Decision 12). */
  onAnnotate: (args: unknown) => void
  /**
   * Test seam. The default spawns the real module Worker from the shim's Blob
   * URL; jsdom has no `Worker` (nor `URL.createObjectURL`), so every unit test
   * injects a `fakeWorker` instead.
   */
  spawn?: (shimUrl: string) => WorkerLike
}

export interface ScriptRunArgs {
  impl: string
  src: string
  /** The evaluated `with` minus `src` (03) — `ctx.inputs`, File refs as-is. */
  inputs: Record<string, unknown>
  /** Cancel / `timeout-minutes`. */
  signal: AbortSignal
}

export interface ScriptRun {
  /** The module's return value, or a `ScriptError` / `AbortError`. */
  outputs: Promise<unknown>
  /** Cancel without a signal — same effect as aborting one. */
  abort(): void
}

export interface ScriptHost {
  /**
   * Fetch the module, spawn the Worker, run it. Throws *synchronously* on a
   * `src` that escapes the bundle (a definition bug, 09); every other failure
   * arrives as a rejection of `outputs`.
   */
  run(a: ScriptRunArgs): ScriptRun
}

/**
 * The shipped `fetchBytes`: the whole point of the page doing this fetch is
 * `credentials: 'same-origin'` — the Worker has no cookies of its own, so a
 * File ref behind the member's session is unreadable from inside it. Exported
 * so the runner wiring uses the same one the host was designed against.
 */
export async function fetchBytes(
  url: string,
): Promise<{ ok: boolean; status: number; body: ArrayBuffer; headers: [string, string][] }> {
  const res = await fetch(url, { credentials: 'same-origin' })
  return {
    ok: res.ok,
    status: res.status,
    body: await res.arrayBuffer(),
    headers: [...res.headers] as [string, string][],
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A message off the wire is `unknown` in practice: absent and `''` mean the same thing. */
function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** An abort is not a failure — the caller distinguishes cancel from timeout. */
function abortError(message: string): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

function objectUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
}

export function createScriptHost(deps: ScriptHostDeps): ScriptHost {
  const spawn = deps.spawn ?? ((shimUrl: string) => new Worker(shimUrl, { type: 'module' }))

  return {
    run(a) {
      // Throws on a `src` that escapes the bundle — a definition bug, not a
      // runtime state (09), so it is not dressed up as SCRIPT_LOAD.
      const url = resolveScriptSrc(a.impl, a.src)

      let settled = false
      let worker: WorkerLike | null = null
      /**
       * The Worker has posted at least one message, so the shim is running and
       * the module imported: an `onerror` after this point is the *script*
       * failing, before it the script failing to *load*.
       */
      let progressed = false
      const urls: string[] = []

      let resolveOutputs!: (outputs: unknown) => void
      let rejectOutputs!: (err: unknown) => void
      const outputs = new Promise<unknown>((resolve, reject) => {
        resolveOutputs = resolve
        rejectOutputs = reject
      })

      const onSignalAbort = () => abort()

      /**
       * Terminate, revoke, unsubscribe. Idempotent, because the abort path
       * defers it by a macrotask and a second settle may land in between.
       */
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        a.signal.removeEventListener('abort', onSignalAbort)
        if (worker) {
          // Detached first: a Worker that posts on its way out must not reach
          // a run that has already resolved.
          worker.onmessage = null
          worker.onerror = null
          worker.terminate()
          worker = null
        }
        for (const revoke of urls.splice(0)) URL.revokeObjectURL(revoke)
      }

      /** Every settle path goes through here; only `abort` defers the teardown. */
      const cleanup = () => {
        settled = true
        dispose()
      }

      const finish = (value: unknown) => {
        if (settled) return
        cleanup()
        resolveOutputs(value)
      }

      const fail = (err: unknown) => {
        if (settled) return
        cleanup()
        rejectOutputs(err)
      }

      function abort(): void {
        if (settled) return
        try {
          worker?.postMessage({ t: 'abort' } satisfies ToWorker)
        } catch {
          // A Worker already gone is exactly the state we wanted.
        }
        // The rejection is immediate — the caller must not wait on a cancelled
        // step — but the teardown is deferred by one macrotask, because
        // `terminate()` in this same turn would kill the Worker before the
        // `abort` message above was ever delivered and `ctx.signal` would never
        // observably fire. `settled` is already true, so nothing the Worker
        // posts in that window reaches the run.
        settled = true
        setTimeout(dispose, 0)
        rejectOutputs(abortError(`script ${url}: cancelled`))
      }

      const send = (msg: ToWorker, transfer?: Transferable[]) => {
        try {
          worker?.postMessage(msg, transfer)
        } catch {
          // The run is being torn down; nothing left to answer.
        }
      }

      /**
       * `ctx.files.fetch`: the page performs the GET the Worker cannot, and
       * only for a url on the file-serve route — same-origin is not enough,
       * or a script could read the run API or another implementation's bundle
       * with the member's session cookie. A refusal and a failed fetch both
       * come back as `error` (the shim rejects); a non-2xx *answer* comes back
       * as a body, because a 404 is a legitimate `Response` for a script to
       * branch on.
       */
      const relay = async (req: RpcReqMessage) => {
        const refUrl: unknown = (req.ref as Partial<FileRef> | undefined)?.url
        if (!isServeUrl(refUrl)) {
          send({
            t: 'rpc:res',
            id: req.id,
            error: `files.fetch ${String(refUrl)}: only /api/uploads/ urls can be fetched from a script`,
          })
          return
        }

        try {
          const res = await deps.fetchBytes(refUrl)
          if (settled) return
          send(
            {
              t: 'rpc:res',
              id: req.id,
              status: res.status,
              headers: res.headers,
              body: res.body,
            },
            [res.body],
          )
        } catch (err) {
          if (settled) return
          send({
            t: 'rpc:res',
            id: req.id,
            error: `files.fetch ${refUrl}: ${messageOf(err)}`,
          })
        }
      }

      const receive = (msg: FromWorker) => {
        if (settled || !msg) return
        progressed = true
        switch (msg.t) {
          case 'log':
            deps.onLog(msg.line)
            return
          case 'annotate':
            deps.onAnnotate(msg.args)
            return
          case 'rpc:req':
            void relay(msg)
            return
          case 'done':
            finish(msg.outputs)
            return
          case 'error':
            fail(
              new ScriptError(
                textOr(msg.code, 'SCRIPT'),
                `script ${url}: ${textOr(msg.message, 'the module failed')}`,
              ),
            )
        }
      }

      void (async () => {
        if (a.signal.aborted) {
          abort()
          return
        }
        a.signal.addEventListener('abort', onSignalAbort)

        let module: { ok: boolean; status: number; text: string }
        try {
          module = await deps.fetchText(url)
        } catch (err) {
          fail(new ScriptError('SCRIPT_LOAD', `script ${url}: ${messageOf(err)}`))
          return
        }
        if (settled) return
        if (!module.ok) {
          fail(new ScriptError('SCRIPT_LOAD', `script ${url}: failed with status ${module.status}`))
          return
        }

        // Two object URLs: the module, and the shim the Worker is spawned from.
        // Both are revoked by `dispose`, whichever way the run ends. Minting
        // one can itself throw (no `URL.createObjectURL`, a blocked Blob), and
        // inside this floating async that would be an unhandled rejection
        // rather than a step failure — so it is caught with the spawn.
        let moduleUrl: string
        try {
          moduleUrl = objectUrl(module.text)
          urls.push(moduleUrl)
          const shimUrl = objectUrl(SHIM_SOURCE)
          urls.push(shimUrl)
          worker = spawn(shimUrl)
        } catch (err) {
          fail(new ScriptError('SCRIPT_LOAD', `script ${url}: ${messageOf(err)}`))
          return
        }

        worker.onmessage = (event: MessageEvent) => receive(event.data as FromWorker)
        worker.onerror = (event: ErrorEvent) => {
          fail(
            new ScriptError(
              progressed ? 'SCRIPT' : 'SCRIPT_LOAD',
              `script ${url}: ${textOr(event.message, 'the worker failed')}`,
            ),
          )
        }
        send({ t: 'run', inputs: a.inputs, moduleUrl })
      })()

      return { outputs, abort }
    },
  }
}
