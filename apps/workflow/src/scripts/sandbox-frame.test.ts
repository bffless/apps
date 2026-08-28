/**
 * The script step's sandbox (Decision 4). jsdom has no `Worker` and never runs
 * a `srcdoc`'s script, so what is proven here is the *page's* half of the
 * contract: the frame it mounts, the `data:` URLs and the port it hands over,
 * the handshake it waits for, and every path that has to take the frame back
 * down again. The Worker actually running inside an opaque origin is proven by
 * the real-Chromium e2e (`e2e/interactive.spec.ts`) and by the spike the
 * module's own doc comment cites.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_HTML, createSandboxWorker } from './sandbox-frame'
import { ScriptError } from './ScriptHost'
import type { FromWorker, ToWorker, WorkerLike } from './rpc'

const SHIM = "self.onmessage = (e) => { post({ t: 'ready' }) }"
const MODULE = 'export default async () => ({ n: 1 })'

const DATA_PREFIX = 'data:text/javascript;base64,'

/** The inverse of the module's own `btoa(unescape(encodeURIComponent(js)))`. */
function decodeDataUrl(url: string): string {
  expect(url.startsWith(DATA_PREFIX)).toBe(true)
  const binary = atob(url.slice(DATA_PREFIX.length))
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

const frames = (): HTMLIFrameElement[] => [
  ...document.querySelectorAll<HTMLIFrameElement>('iframe[data-script-sandbox]'),
]

interface Spawn {
  message: { t?: string; shim?: string; module?: string }
  transfer: Transferable[] | undefined
}

interface Mounted {
  worker: Promise<WorkerLike>
  frame: HTMLIFrameElement
  spawns: Spawn[]
  controller: AbortController
}

/**
 * Mount, then stand in for the bootstrap script: jsdom parses `srcdoc` but
 * never executes it, so the test plays the frame — it captures what the page
 * posted in (including the transferred port) and answers on that port.
 */
function mount(over: { signal?: AbortSignal; moduleSource?: string } = {}): Mounted {
  const controller = new AbortController()
  const spawns: Spawn[] = []
  const worker = createSandboxWorker({
    shimSource: SHIM,
    moduleSource: over.moduleSource ?? MODULE,
    signal: over.signal ?? controller.signal,
  })
  const mounted = frames()
  expect(mounted).toHaveLength(1)
  const frame = mounted[0]
  const win = frame.contentWindow as unknown as {
    postMessage: (message: unknown, origin: string, transfer?: Transferable[]) => void
  }
  win.postMessage = (message, _origin, transfer) => {
    spawns.push({ message: message as Spawn['message'], transfer })
  }
  return { worker, frame, spawns, controller }
}

/** The frame's port, once the page has handed it over. */
async function handover(m: Mounted): Promise<MessagePort> {
  await vi.waitFor(() => expect(m.spawns).toHaveLength(1))
  const port = m.spawns[0].transfer?.[0]
  expect(port).toBeInstanceOf(MessagePort)
  return port as MessagePort
}

/** What the frame reports to the page when the Worker itself cannot be had. */
function sandboxError(m: Mounted, message: string): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: m.frame.contentWindow,
      data: { t: 'sandbox-error', message },
    }),
  )
}

const failure = async (worker: Promise<WorkerLike>): Promise<Error & { code?: string }> => {
  const err = await worker.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  return err as Error & { code?: string }
}

afterEach(() => {
  for (const frame of frames()) frame.remove()
})

describe('BOOTSTRAP_HTML', () => {
  it('is self-contained: no external URL, and no way back to the harness origin', () => {
    expect(BOOTSTRAP_HTML).not.toContain('allow-same-origin')
    expect(BOOTSTRAP_HTML).not.toMatch(/https?:/)
    expect(BOOTSTRAP_HTML).not.toMatch(/\bsrc\s*=/)
  })

  it('spawns a module Worker from the posted url and reports a failure to the page', () => {
    expect(BOOTSTRAP_HTML).toMatch(/new Worker\(/)
    expect(BOOTSTRAP_HTML).toContain("type: 'module'")
    expect(BOOTSTRAP_HTML).toContain("t: 'sandbox-error'")
    // The port is handed to the Worker and never used by the frame again
    // (a transferred port is neutered): the frame's only channel back to the
    // page is `parent.postMessage`.
    expect(BOOTSTRAP_HTML).toContain('parent.postMessage')
    expect(BOOTSTRAP_HTML).toMatch(/postMessage\(\s*\{\s*t:\s*'port'/)
  })
})

describe('createSandboxWorker', () => {
  it('mounts one hidden script-only frame and hands it both sources as data: URLs', async () => {
    const m = mount()
    expect(m.frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(m.frame.getAttribute('aria-hidden')).toBe('true')
    expect(m.frame.style.display).toBe('none')
    expect(m.frame.srcdoc).toBe(BOOTSTRAP_HTML)

    await handover(m)
    expect(m.spawns[0].message.t).toBe('spawn')
    expect(decodeDataUrl(m.spawns[0].message.shim!)).toBe(SHIM)
    expect(decodeDataUrl(m.spawns[0].message.module!)).toBe(MODULE)
  })

  it('encodes a module whose text is not ASCII', async () => {
    const source = 'export default async () => ({ n: "café ☕" })'
    const m = mount({ moduleSource: source })
    await handover(m)
    expect(decodeDataUrl(m.spawns[0].message.module!)).toBe(source)
  })

  it('resolves a WorkerLike once the shim answers ready, and relays both ways', async () => {
    const m = mount()
    const port = await handover(m)

    const fromPage: ToWorker[] = []
    port.onmessage = (event: MessageEvent) => fromPage.push(event.data as ToWorker)
    port.postMessage({ t: 'ready' } satisfies FromWorker)

    const worker = await m.worker
    const received: FromWorker[] = []
    worker.onmessage = (event) => received.push(event.data as FromWorker)

    worker.postMessage({ t: 'run', inputs: { a: 1 } } satisfies ToWorker)
    await vi.waitFor(() => expect(fromPage).toEqual([{ t: 'run', inputs: { a: 1 } }]))

    port.postMessage({ t: 'log', line: 'drawing' } satisfies FromWorker)
    await vi.waitFor(() => expect(received).toEqual([{ t: 'log', line: 'drawing' }]))

    // `terminate()` is the only teardown the host knows about, and it takes
    // the whole sandbox with it.
    worker.terminate()
    expect(frames()).toHaveLength(0)
  })

  it('rejects SCRIPT_LOAD when the frame cannot spawn the Worker at all', async () => {
    const m = mount()
    await handover(m)
    sandboxError(m, 'SecurityError: worker blocked')

    const err = await failure(m.worker)
    expect(err).toBeInstanceOf(ScriptError)
    expect(err.code).toBe('SCRIPT_LOAD')
    expect(err.message).toContain('worker blocked')
    expect(frames()).toHaveLength(0)
  })

  it('reports a sandbox error after the handover through onerror, the way a Worker would', async () => {
    const m = mount()
    const port = await handover(m)
    port.postMessage({ t: 'ready' } satisfies FromWorker)
    const worker = await m.worker

    const errors: string[] = []
    worker.onerror = (event) => errors.push(event.message)
    sandboxError(m, 'RangeError: out of memory')
    await vi.waitFor(() => expect(errors).toEqual(['RangeError: out of memory']))
    // The host decides what that means and terminates; nothing is torn down
    // behind its back.
    expect(frames()).toHaveLength(1)
  })

  it('ignores messages that did not come from its own frame', async () => {
    const m = mount()
    await handover(m)
    window.dispatchEvent(
      new MessageEvent('message', { data: { t: 'sandbox-error', message: 'not ours' } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(frames()).toHaveLength(1)
  })

  it('stops listening once the sandbox is gone', async () => {
    const m = mount()
    const port = await handover(m)
    port.postMessage({ t: 'ready' } satisfies FromWorker)
    const worker = await m.worker
    const errors: string[] = []
    worker.onerror = (event) => errors.push(event.message)

    worker.terminate()
    sandboxError(m, 'too late')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(errors).toEqual([])
  })

  it('rejects AbortError and removes the frame when the run is cancelled while spawning', async () => {
    const m = mount()
    await handover(m)
    m.controller.abort()

    const err = await failure(m.worker)
    expect(err.name).toBe('AbortError')
    expect(frames()).toHaveLength(0)
  })

  it('never mounts anything for a signal that is already aborted', async () => {
    const worker = createSandboxWorker({
      shimSource: SHIM,
      moduleSource: MODULE,
      signal: AbortSignal.abort(),
    })
    expect(frames()).toHaveLength(0)
    await expect(worker).rejects.toMatchObject({ name: 'AbortError' })
  })
})
