/**
 * The script step's sandbox (plan Decision 4): a hidden `sandbox="allow-scripts"`
 * iframe — an opaque origin, exactly what islands get (04) — that spawns the
 * step's Worker from `data:` URLs.
 *
 * Spiked 2026-08-27 (`localdev-tools/workflow-sandbox-worker-spike.mjs`): a
 * `data:` module Worker created *there* has origin `null` in Chromium and
 * Firefox — a relative `fetch` throws, an absolute one is refused by CORS, and
 * neither carries cookies. Created from the page, Chromium would instead give
 * the Worker the page's own origin and with it the member's session, which is
 * what this whole file exists to prevent. `blob:` is not interchangeable: a
 * `blob:` module Worker inside the sandbox fails in Chromium with a muted
 * error, so both halves cross as `data:`.
 *
 * The frame is a courier, not a participant. It receives the two sources and
 * one end of a `MessageChannel`, hands that port straight to the Worker, and
 * says nothing else — a transferred port is neutered, so the frame could not
 * speak on it afterwards even if it wanted to. Every message the step actually
 * cares about (`run`, `log`, `annotate`, the `ctx.files.fetch` round trip) is
 * therefore one hop, page ↔ Worker, and the only thing the frame reports back
 * is the one thing the port cannot carry: a Worker that never came up at all.
 */
import { abortError, ScriptError } from './errors'
import type { ToWorker, WorkerLike } from './rpc'

/**
 * The frame's whole program. It is inert on its own — everything it acts on
 * arrives in the `spawn` message — and it names no URL, so nothing about the
 * harness origin leaks into the sandbox.
 */
export const BOOTSTRAP_HTML = `<!doctype html><meta charset="utf-8"><script>
addEventListener('message', (e) => {
  if (!e.data || e.data.t !== 'spawn' || !e.ports[0]) return
  const fail = (message) => { parent.postMessage({ t: 'sandbox-error', message: String(message) }, '*') }
  let worker
  try { worker = new Worker(e.data.shim, { type: 'module' }) } catch (err) { fail(err); return }
  worker.onerror = (ev) => { fail((ev && ev.message) || 'the worker failed') }
  worker.postMessage({ t: 'port', moduleUrl: e.data.module }, [e.ports[0]])
})
</script>`

/** What the page sends into the frame, once — the frame's only input. */
interface SpawnMessage {
  t: 'spawn'
  /** The shim, as a `data:` URL: what `new Worker` is pointed at. */
  shim: string
  /** The step's module, as a `data:` URL: what the shim `import()`s. */
  module: string
}

/** What the frame sends back — never data, only "there is no Worker". */
interface SandboxErrorMessage {
  t: 'sandbox-error'
  message: string
}

export interface SandboxSpawnArgs {
  /** `SHIM_SOURCE` — the Worker's own bootstrap, as text. */
  shimSource: string
  /** The step's module text, which the *page* fetched (it needs the cookie). */
  moduleSource: string
  /** Cancel / `timeout-minutes`, while the sandbox is still coming up. */
  signal: AbortSignal
}

/**
 * `btoa` is Latin-1, so a module with any non-ASCII character in it (a `☕` in
 * a template literal, a smart quote in a comment) has to be UTF-8 bytes first.
 */
const dataUrl = (js: string): string =>
  'data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(js)))

/** A message off the wire is `unknown` in practice: absent and `''` mean the same thing. */
function textOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

/**
 * The port, dressed as the slice of `Worker` the host drives. `terminate` is
 * the host's only teardown verb, so it is what takes the whole sandbox down —
 * the frame goes with the Worker inside it.
 */
function portWorker(port: MessagePort, dispose: () => void): WorkerLike {
  return {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown, transfer?: Transferable[]) {
      port.postMessage(message as ToWorker, transfer ?? [])
    },
    terminate() {
      dispose()
    },
  }
}

/**
 * Mount the sandbox and hand back the Worker inside it, once the shim has
 * acknowledged the port it was given (`{ t: 'ready' }`). Rejects with
 * `SCRIPT_LOAD` if the Worker could not be spawned at all, and with an
 * `AbortError` if the run was cancelled before any of that finished. After the
 * handover, a Worker that dies is reported the way a real one is — through
 * `onerror` — because by then it is the *host* that knows whether the module
 * had started, and so which code the step failed under.
 */
export function createSandboxWorker(a: SandboxSpawnArgs): Promise<WorkerLike> {
  return new Promise<WorkerLike>((resolve, reject) => {
    if (a.signal.aborted) {
      reject(abortError('script: cancelled before the sandbox was mounted'))
      return
    }

    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    // Not a document, not a landmark, not focusable: the frame carries no UI
    // at all, and `data-script-sandbox` is how the e2e proves it is gone again.
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('data-script-sandbox', '')
    frame.title = 'script sandbox'
    frame.style.display = 'none'

    const channel = new MessageChannel()
    /** Set once the shim answers: after this the host, not this promise, owns the failures. */
    let ready = false
    const worker = portWorker(channel.port1, () => dispose())

    let disposed = false
    function dispose(): void {
      if (disposed) return
      disposed = true
      window.removeEventListener('message', onFrameMessage)
      a.signal.removeEventListener('abort', onAbort)
      channel.port1.onmessage = null
      channel.port1.close()
      frame.remove()
    }

    /**
     * The frame's own channel (R42): the port belongs to the Worker, so a
     * Worker that never started has nothing to report on. Filtered by source,
     * because `window` hears every frame on the page.
     */
    function onFrameMessage(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) return
      const data = event.data as Partial<SandboxErrorMessage> | null
      if (data?.t !== 'sandbox-error') return
      const message = textOr(data.message, 'the sandbox could not start the worker')
      if (ready) {
        // Indistinguishable from a Worker `error` event, which is the point:
        // the host already maps that to SCRIPT or SCRIPT_LOAD by whether the
        // module had made progress, and then terminates.
        worker.onerror?.(new ErrorEvent('error', { message }))
        return
      }
      dispose()
      reject(new ScriptError('SCRIPT_LOAD', message))
    }

    function onAbort(): void {
      // After the handover the host owns cancellation: it posts `abort` so the
      // module's `ctx.signal` fires, and terminates a macrotask later.
      if (ready) return
      dispose()
      reject(abortError('script: cancelled while spawning'))
    }

    channel.port1.onmessage = (event: MessageEvent) => {
      if (ready) {
        worker.onmessage?.(event)
        return
      }
      // The shim's first word is `ready`; nothing else can legally precede it.
      if ((event.data as { t?: unknown } | null)?.t !== 'ready') return
      ready = true
      resolve(worker)
    }

    window.addEventListener('message', onFrameMessage)
    a.signal.addEventListener('abort', onAbort, { once: true })

    frame.onload = () => {
      const message: SpawnMessage = {
        t: 'spawn',
        shim: dataUrl(a.shimSource),
        module: dataUrl(a.moduleSource),
      }
      // `'*'` because the frame *has* no origin to name — that is the feature.
      frame.contentWindow?.postMessage(message, '*', [channel.port2])
    }
    frame.srcdoc = BOOTSTRAP_HTML
    document.body.append(frame)
  })
}
