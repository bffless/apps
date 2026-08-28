/**
 * The Worker's own bootstrap, as text (03).
 *
 * A script step's module is fetched by the *page* (it needs the member's
 * cookie) and handed to the Worker as a `data:` URL, so the Worker cannot
 * simply be `new Worker(moduleUrl)`: something has to build the `ctx` the
 * module is called with first. That something is this shim — a second `data:`
 * URL, spawned as `{ type: 'module' }`, which dynamically imports the script's
 * URL and relays every capability the module asks for back to the page.
 *
 * Why a **string** rather than a `new Worker(new URL('./worker-shim.ts', import.meta.url))`
 * entry: the shim has to reach the browser as a URL built at runtime either way
 * (the page has nothing to serve a compiled worker chunk from in dev, and a
 * bundled entry would drag the app's module graph into the Worker), and a
 * literal is the one form no bundler rewrites. The rules that keep it honest —
 * no static `import`/`export`, the only import is `import(moduleUrl)`, and it
 * answers on the port rather than on `self` — are asserted in `rpc.test.ts`,
 * which is also the only place the app parses it.
 *
 * The port matters (Decision 4): the Worker is spawned inside a sandboxed
 * iframe, so `self.postMessage` would reach the *frame*, not the page. The
 * frame's one job is to hand over the page's `MessagePort`; from `{ t: 'port' }`
 * on, everything goes down that port and the frame is out of the conversation.
 *
 * Keep it plain ES2022 JavaScript: nothing type-checks this text.
 */

/** @see ToWorker / FromWorker in `rpc.ts` — the two ends must agree by hand. */
export const SHIM_SOURCE = `
// The script step's Worker bootstrap. Built from a data: URL by ScriptHost.ts,
// inside the sandbox frame; see apps/workflow/src/scripts/worker-shim.ts for
// why this is a string.
const pending = new Map()
let nextId = 1
let controller = null
let port = null
let moduleUrl = ''

const post = (msg) => { port.postMessage(msg) }

const textOf = (err) => {
  if (err && typeof err.message === 'string' && err.message !== '') return err.message
  return String(err)
}

// One RPC round trip: the page owns the network, so ctx.files.fetch is a
// request the page answers with bytes (or with an error it refused for).
const request = (op, ref) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  post({ t: 'rpc:req', id: id, op: op, ref: ref })
})

const answer = (msg) => {
  const entry = pending.get(msg.id)
  if (!entry) return
  pending.delete(msg.id)
  if (msg.error) { entry.reject(new Error(msg.error)); return }
  // A Response the page's answer cannot legally build (an out-of-range status,
  // a malformed header pair) must reject *this* fetch, not throw out of
  // onmessage where nothing would ever settle the promise.
  try {
    const status = typeof msg.status === 'number' ? msg.status : 200
    const bodiless = status === 204 || status === 205 || status === 304
    entry.resolve(new Response(bodiless ? null : (msg.body || null), {
      status: status,
      headers: msg.headers || [],
    }))
  } catch (err) {
    entry.reject(err instanceof Error ? err : new Error(textOf(err)))
  }
}

const run = async (msg) => {
  controller = new AbortController()

  let mod
  try {
    mod = await import(moduleUrl)
  } catch (err) {
    post({ t: 'error', code: 'SCRIPT_LOAD', message: textOf(err) })
    return
  }

  if (!mod || typeof mod.default !== 'function') {
    post({ t: 'error', code: 'SCRIPT_LOAD', message: 'the script module has no default function' })
    return
  }

  const ctx = {
    inputs: msg.inputs || {},
    files: { fetch: (ref) => request('files.fetch', ref) },
    log: (line) => { post({ t: 'log', line: String(line) }) },
    annotate: (args) => { post({ t: 'annotate', args: args }) },
    signal: controller.signal,
  }

  try {
    const outputs = await mod.default(ctx)
    post({ t: 'done', outputs: outputs })
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : undefined
    post({ t: 'error', code: code, message: textOf(err) })
  }
}

const handle = (msg) => {
  if (!msg) return
  if (msg.t === 'run') { void run(msg); return }
  if (msg.t === 'rpc:res') { answer(msg); return }
  if (msg.t === 'abort' && controller) controller.abort()
}

// The handover, and the only thing this Worker ever takes off self: the frame
// that spawned it is not the page, so the page is reachable only on the port.
self.onmessage = (event) => {
  if (!event.data || event.data.t !== 'port' || !event.ports[0]) return
  self.onmessage = null
  port = event.ports[0]
  moduleUrl = event.data.moduleUrl
  port.onmessage = (ev) => { handle(ev.data) }
  post({ t: 'ready' })
}
`
