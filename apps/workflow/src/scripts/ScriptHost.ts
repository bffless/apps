/**
 * The script host (03): the IO half of a `script` step.
 *
 * A script step is an ES module from the implementation's own bundle, run in a
 * Worker. The page — not the Worker — fetches it, because the bundle is behind
 * the member's session cookie; the text then goes to `sandbox-frame.ts`, which
 * mounts an opaque-origin sandbox and spawns the Worker in there from `data:`
 * URLs — the module's, and the shim's (`worker-shim.ts`). The shim dynamically
 * imports the module and builds its `ctx`, so every capability the module has
 * is one this host answers over `postMessage`: `ctx.log`, `ctx.annotate`, and
 * `ctx.files.fetch` — the only network any of this performs, and only ever for
 * a url on the harness's own file-serve route (`lib/url`'s `isServeUrl`): a
 * script, like an island, may not reach any other route with the member's
 * cookies. Since Decision 4 that gate is a wall rather than a fence: the
 * Worker's own `fetch` has no origin to reach the harness with.
 *
 * This module owns the *effects*: the fetch, the sandbox, the RPC relay,
 * cancellation. Everything decidable from plain data — where a `src` resolves
 * to, what the module's return value must look like — lives in the pure
 * adapter (`lib/runner/adapters/script.ts`) and is imported from here, the
 * same one-way fence `islands/IslandHost.ts` keeps: `lib/runner/**` must never
 * import this file.
 */
import { resolveScriptSrc } from '../lib/runner/adapters/script'
import { SERVE_PREFIX } from '../lib/coerce'
import { isServeUrl } from '../lib/url'
import type { FileRef } from '../lib/runner/types'
import { abortError, ScriptError } from './errors'
import type { FromWorker, RpcReqMessage, ToWorker, WorkerLike } from './rpc'
import { createSandboxWorker, type SandboxSpawnArgs } from './sandbox-frame'
import { SHIM_SOURCE } from './worker-shim'

export { ScriptError } from './errors'

/**
 * The shipped `spawn`: the sandbox, not a bare `new Worker` (Decision 4).
 * Named so a test can assert the seam's default *is* it, rather than
 * re-deriving what "the real one" means.
 */
export const DEFAULT_SPAWN = createSandboxWorker

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
   * Test seam. The default (`DEFAULT_SPAWN`) mounts the opaque-origin sandbox
   * and resolves once the shim inside it has the port; jsdom has no `Worker`,
   * so every unit test injects a `fakeWorker` instead.
   */
  spawn?: (a: SandboxSpawnArgs) => Promise<WorkerLike>
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

export function createScriptHost(deps: ScriptHostDeps): ScriptHost {
  const spawn = deps.spawn ?? DEFAULT_SPAWN

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
      /**
       * The host's own cancel line to the sandbox. `a.signal` is not enough:
       * `run.abort()` is a second way to cancel that never touches it, and a
       * sandbox left half-spawned would keep its frame on the page forever.
       */
      const spawning = new AbortController()

      let resolveOutputs!: (outputs: unknown) => void
      let rejectOutputs!: (err: unknown) => void
      const outputs = new Promise<unknown>((resolve, reject) => {
        resolveOutputs = resolve
        rejectOutputs = reject
      })

      const onSignalAbort = () => abort()

      /**
       * Terminate, unmount, unsubscribe. Idempotent, because the abort path
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
        // A no-op once the handover happened (the sandbox stops listening
        // then); everything before it, this is what takes the frame down.
        spawning.abort()
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
        } catch (err) {
          // A message that cannot be posted (a body the structured clone
          // refuses, a Worker already gone) is not something to swallow: a
          // dropped `rpc:res` would leave the module awaiting an answer that
          // never comes, and the step `running` with it (apps#375). After
          // `settled`, `fail` is a no-op — the teardown case costs nothing.
          fail(new ScriptError('SCRIPT', `script ${url}: ${messageOf(err)}`))
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
            error: `files.fetch ${String(refUrl)}: only ${SERVE_PREFIX} urls can be fetched from a script`,
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

        // Both halves cross as source text: the `data:` URLs are minted inside
        // the sandbox, which is the only place a Worker made from them lands
        // on an opaque origin (Decision 4).
        let spawned: WorkerLike
        try {
          spawned = await spawn({
            shimSource: SHIM_SOURCE,
            moduleSource: module.text,
            signal: spawning.signal,
          })
        } catch (err) {
          // Cancellation has already rejected the run and disposed the
          // sandbox; anything else is a Worker that never came up.
          if (settled) return
          const code = err instanceof ScriptError ? err.code : 'SCRIPT_LOAD'
          fail(new ScriptError(code, `script ${url}: ${messageOf(err)}`))
          return
        }
        // The run may have settled while the sandbox was coming up, in which
        // case `dispose` has already been and gone: this one is ours to unmount.
        if (settled) {
          spawned.terminate()
          return
        }
        worker = spawned

        worker.onmessage = (event: MessageEvent) => receive(event.data as FromWorker)
        worker.onerror = (event: ErrorEvent) => {
          fail(
            new ScriptError(
              progressed ? 'SCRIPT' : 'SCRIPT_LOAD',
              `script ${url}: ${textOr(event.message, 'the worker failed')}`,
            ),
          )
        }
        send({ t: 'run', inputs: a.inputs })
      })()

      return { outputs, abort }
    },
  }
}
