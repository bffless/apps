/**
 * The script host (03): the Worker half of a script step, driven against
 * `fakeWorker` — jsdom has no `Worker`, so every test injects one through
 * `ScriptHostDeps.spawn`, the seam whose shipped implementation mounts the
 * opaque-origin sandbox (`sandbox-frame.ts`, Decision 4) and is proven in its
 * own suite.
 *
 * What is *not* asserted here is that the shim actually runs: that is
 * `rpc.test.ts` (the text parses and has no static imports) plus the
 * real-browser check in the task report.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeWorker, type FakeWorker } from './fakeWorker'
import {
  createScriptHost,
  DEFAULT_SPAWN,
  ScriptError,
  type ScriptHostDeps,
  type ScriptRun,
} from './ScriptHost'
import { createSandboxWorker, type SandboxSpawnArgs } from './sandbox-frame'
import type { FromWorker, RpcReqMessage, RpcResMessage, RunMessage, ToWorker } from './rpc'
import { SHIM_SOURCE } from './worker-shim'

const MODULE_TEXT = 'export default async () => ({ n: 1 })'

const REF = {
  path: 'runs/1/in.txt',
  name: 'in.txt',
  contentType: 'text/plain',
  size: 3,
  url: '/api/uploads/runs/1/in.txt',
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const frame of document.querySelectorAll('iframe[data-script-sandbox]')) frame.remove()
})

// --- harness ---------------------------------------------------------------

interface Harness {
  host: ReturnType<typeof createScriptHost>
  worker: FakeWorker
  spawns: SandboxSpawnArgs[]
  fetchText: ReturnType<typeof vi.fn>
  fetchBytes: ReturnType<typeof vi.fn>
  onLog: ReturnType<typeof vi.fn>
  onAnnotate: ReturnType<typeof vi.fn>
}

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer
}

function makeHarness(worker: FakeWorker, over: Partial<ScriptHostDeps> = {}): Harness {
  const spawns: SandboxSpawnArgs[] = []
  const fetchText = vi.fn(async () => ({ ok: true, status: 200, text: MODULE_TEXT }))
  const fetchBytes = vi.fn(async () => ({
    ok: true,
    status: 200,
    body: bytes('hi!'),
    headers: [['content-type', 'text/plain']] as [string, string][],
  }))
  const onLog = vi.fn()
  const onAnnotate = vi.fn()

  const host = createScriptHost({
    fetchText: fetchText as unknown as ScriptHostDeps['fetchText'],
    fetchBytes: fetchBytes as unknown as ScriptHostDeps['fetchBytes'],
    onLog,
    onAnnotate,
    spawn: async (args) => {
      spawns.push(args)
      return worker
    },
    ...over,
  })

  return { host, worker, spawns, fetchText, fetchBytes, onLog, onAnnotate }
}

function start(h: Harness, over: { impl?: string; src?: string; signal?: AbortSignal } = {}) {
  return h.host.run({
    impl: 'hello',
    src: 'scripts/bundle.js',
    inputs: { markdown: '# hi' },
    signal: new AbortController().signal,
    ...over,
  })
}

const runMessage = (worker: FakeWorker): RunMessage => {
  const msg = worker.received.find((m): m is RunMessage => m.t === 'run')
  if (!msg) throw new Error('the host never posted `run`')
  return msg
}

/** The error a run rejected with — `expect().rejects` yields a matcher, not the value. */
const failure = async (run: ScriptRun): Promise<Error & { code?: string }> => {
  const err = await run.outputs.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  return err as Error & { code?: string }
}

const codeOf = async (run: ScriptRun): Promise<string | undefined> => {
  const err = await failure(run)
  expect(err).toBeInstanceOf(ScriptError)
  return err.code
}

// ---------------------------------------------------------------------------

describe('createScriptHost', () => {
  it('runs the module in a Worker spawned from the shim and resolves with its outputs', async () => {
    const worker = createFakeWorker({
      run: () => [
        { t: 'log', line: 'zipping' },
        { t: 'rpc:req', id: 1, op: 'files.fetch', ref: REF },
      ],
      rpcRes: () => [{ t: 'done', outputs: { n: 1 } }],
    })
    const h = makeHarness(worker)

    const run = start(h)
    await expect(run.outputs).resolves.toEqual({ n: 1 })

    // The module came from the bundle, and both halves went to the sandbox as
    // source text — the `data:` URLs are minted inside it (Decision 4).
    expect(h.fetchText).toHaveBeenCalledWith('/w/hello/scripts/bundle.js')
    expect(h.spawns).toHaveLength(1)
    expect(h.spawns[0].shimSource).toBe(SHIM_SOURCE)
    expect(h.spawns[0].moduleSource).toBe(MODULE_TEXT)
    // The shim already has the module URL from the handover, so `run` carries
    // nothing but the inputs.
    expect(runMessage(worker)).toEqual({ t: 'run', inputs: { markdown: '# hi' } })

    // `ctx.log` reached the step card.
    expect(h.onLog).toHaveBeenCalledWith('zipping')

    // `ctx.files.fetch` was relayed by the *page* — the Worker never fetches.
    expect(h.fetchBytes).toHaveBeenCalledWith(REF.url)
    const answer = worker.received.find((m) => m.t === 'rpc:res')
    expect(answer).toMatchObject({ id: 1, status: 200 })
    const body = (answer as Extract<ToWorker, { t: 'rpc:res' }>).body
    expect(new TextDecoder().decode(body)).toBe('hi!')
    expect(worker.transfers[worker.received.indexOf(answer!)]).toEqual([body])

    // Settled: the Worker is gone, and with it the sandbox it ran in.
    expect(worker.terminated).toBe(1)
  })

  it('forwards ctx.annotate', async () => {
    const args = { level: 'warning', message: 'slow' }
    const worker = createFakeWorker({
      run: () => [
        { t: 'annotate', args },
        { t: 'done', outputs: {} },
      ],
    })
    const h = makeHarness(worker)

    await expect(start(h).outputs).resolves.toEqual({})
    expect(h.onAnnotate).toHaveBeenCalledWith(args)
  })

  it("rejects with the module's own error code, and SCRIPT when it has none", async () => {
    const boom = createFakeWorker({
      run: () => [{ t: 'error', code: 'BOOM', message: 'exploded' }],
    })
    const h = makeHarness(boom)
    const err = await failure(start(h))
    expect(err.code).toBe('BOOM')
    expect(err.message).toContain('exploded')
    expect(boom.terminated).toBe(1)

    const plain = createFakeWorker({ run: () => [{ t: 'error', message: 'exploded' }] })
    await expect(codeOf(start(makeHarness(plain)))).resolves.toBe('SCRIPT')
  })

  it('rejects SCRIPT_LOAD when the module is not 2xx, or the fetch itself fails', async () => {
    const notFound = makeHarness(createFakeWorker(), {
      fetchText: async () => ({ ok: false, status: 404, text: '<!doctype html>' }),
    })
    await expect(codeOf(start(notFound))).resolves.toBe('SCRIPT_LOAD')
    // Nothing was spawned, so no sandbox was ever mounted either.
    expect(notFound.spawns).toEqual([])

    const offline = makeHarness(createFakeWorker(), {
      fetchText: async () => {
        throw new Error('network down')
      },
    })
    await expect(codeOf(start(offline))).resolves.toBe('SCRIPT_LOAD')
  })

  it('rejects SCRIPT_LOAD for a Worker error before the module ran, SCRIPT after', async () => {
    const early = createFakeWorker()
    const h = makeHarness(early)
    const run = start(h)
    await vi.waitFor(() => expect(early.received).toHaveLength(1))
    early.fail('SyntaxError: Unexpected token')
    await expect(codeOf(run)).resolves.toBe('SCRIPT_LOAD')

    const late = createFakeWorker({ run: () => [{ t: 'log', line: 'started' }] })
    const h2 = makeHarness(late)
    const run2 = start(h2)
    await vi.waitFor(() => expect(h2.onLog).toHaveBeenCalled())
    late.fail('RangeError: out of memory')
    await expect(codeOf(run2)).resolves.toBe('SCRIPT')
  })

  // The final whole-branch review (I1/I2): the gate is the file-serve *route*,
  // not "starts with a slash" — `/\\host/x` resolves off-site, and a plain
  // same-origin path would let a script read the run API (or another
  // implementation's bundle) with the member's session cookie.
  it.each([
    'https://evil.example/secret',
    '//evil.example/x',
    '/\\evil.example/x',
    '\t/\\evil.example/x',
    '/api/workflow/run?id=1',
    '/w/other/scripts/steal.js',
  ])('refuses to relay a files.fetch for %j', async (url) => {
    const offRoute: RpcReqMessage = {
      t: 'rpc:req',
      id: 7,
      op: 'files.fetch',
      ref: { ...REF, url },
    }
    const worker = createFakeWorker({
      run: () => [offRoute],
      rpcRes: (msg) => [{ t: 'error', message: msg.error ?? 'no error' }],
    })
    const h = makeHarness(worker)

    await expect(codeOf(start(h))).resolves.toBe('SCRIPT')
    expect(h.fetchBytes).not.toHaveBeenCalled()
    const answer = worker.received.find((m) => m.t === 'rpc:res')
    expect(answer).toMatchObject({ id: 7 })
    expect((answer as RpcResMessage).error).toContain('/api/uploads/')
  })

  it('relays a files.fetch for a serve-route url', async () => {
    const worker = createFakeWorker({
      run: () => [
        { t: 'rpc:req', id: 3, op: 'files.fetch', ref: { ...REF, url: '/api/uploads/a/b.json' } },
      ],
      rpcRes: () => [{ t: 'done', outputs: {} }],
    })
    const h = makeHarness(worker)

    await expect(start(h).outputs).resolves.toEqual({})
    expect(h.fetchBytes).toHaveBeenCalledWith('/api/uploads/a/b.json')
  })

  it('fails the run when an answer cannot be posted to the Worker, rather than leaving the module awaiting it forever (apps#375)', async () => {
    const worker = createFakeWorker({
      run: () => [{ t: 'rpc:req', id: 2, op: 'files.fetch', ref: REF }],
    })
    const post = worker.postMessage.bind(worker)
    worker.postMessage = (msg, transfer) => {
      if ((msg as ToWorker).t === 'rpc:res') throw new DOMException('body could not be cloned', 'DataCloneError')
      post(msg, transfer)
    }
    const h = makeHarness(worker)

    const err = await failure(start(h))
    expect(err.code).toBe('SCRIPT')
    expect(err.message).toContain('body could not be cloned')
    expect(worker.terminated).toBe(1)
  })

  it('answers a failed relay with an error rather than a body', async () => {
    const worker = createFakeWorker({
      run: () => [{ t: 'rpc:req', id: 2, op: 'files.fetch', ref: REF }],
      rpcRes: (msg) => [{ t: 'error', message: msg.error ?? 'no error' }],
    })
    const h = makeHarness(worker, {
      fetchBytes: async () => {
        throw new Error('connection reset')
      },
    })

    const err = await failure(start(h))
    expect(err.message).toContain('connection reset')
    expect(worker.received.find((m) => m.t === 'rpc:res')).toMatchObject({ id: 2 })
  })

  /**
   * The final whole-branch review (I3): terminating in the same turn as the
   * `abort` post meant `ctx.signal` never observably fired — the Worker was
   * gone before the message was delivered. The rejection stays immediate; the
   * teardown is one macrotask later, which is the window a module's (synchronous,
   * best-effort) `ctx.signal` handler runs in.
   */
  it('aborts: posts abort, rejects AbortError at once, and terminates one macrotask later', async () => {
    const worker = createFakeWorker({ run: () => [{ t: 'log', line: 'working' }] })
    const h = makeHarness(worker)
    const controller = new AbortController()

    const run = start(h, { signal: controller.signal })
    await vi.waitFor(() => expect(h.onLog).toHaveBeenCalled())
    controller.abort()

    const err = await failure(run)
    expect(err.name).toBe('AbortError')
    // Delivered *before* the Worker is torn down — the whole point of the defer.
    expect(worker.received.at(-1)).toEqual({ t: 'abort' })
    expect(worker.terminated).toBe(0)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(worker.terminated).toBe(1)
  })

  it('does not terminate twice when the signal aborts a run that is already aborting', async () => {
    const worker = createFakeWorker({ run: () => [{ t: 'log', line: 'working' }] })
    const h = makeHarness(worker)
    const controller = new AbortController()

    const run = start(h, { signal: controller.signal })
    await vi.waitFor(() => expect(h.onLog).toHaveBeenCalled())
    run.abort()
    controller.abort()

    await expect(run.outputs).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(worker.terminated).toBe(1)
  })

  it('aborts on request, and never spawns for an already-aborted signal', async () => {
    const worker = createFakeWorker({ run: () => [{ t: 'log', line: 'working' }] })
    const h = makeHarness(worker)
    const run = start(h)
    await vi.waitFor(() => expect(h.onLog).toHaveBeenCalled())
    run.abort()
    await expect(run.outputs).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminated).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(worker.terminated).toBe(1)

    const pre = makeHarness(createFakeWorker())
    const aborted = AbortSignal.abort()
    const early = start(pre, { signal: aborted })
    await expect(early.outputs).rejects.toMatchObject({ name: 'AbortError' })
    expect(pre.fetchText).not.toHaveBeenCalled()
    expect(pre.spawns).toEqual([])
  })

  it('throws synchronously on a src that escapes the implementation bundle', () => {
    const h = makeHarness(createFakeWorker())
    expect(() => start(h, { src: '../other/steal.js' })).toThrow(/script src/)
    expect(() => start(h, { src: 'https://evil.example/x.js' })).toThrow(/script src/)
  })

  /**
   * The seam's default is the sandbox, not a bare `new Worker` — the whole
   * point of Decision 4. Asserted by identity *and* by effect: a host built
   * without a `spawn` mounts the frame, and gives it back when the run ends.
   */
  it('spawns into the opaque-origin sandbox by default', async () => {
    expect(DEFAULT_SPAWN).toBe(createSandboxWorker)

    const host = createScriptHost({
      fetchText: async () => ({ ok: true, status: 200, text: MODULE_TEXT }),
      fetchBytes: async () => ({ ok: true, status: 200, body: bytes(''), headers: [] }),
      onLog: vi.fn(),
      onAnnotate: vi.fn(),
    })
    const run = host.run({
      impl: 'hello',
      src: 'scripts/bundle.js',
      inputs: {},
      signal: new AbortController().signal,
    })
    const sandboxes = () => document.querySelectorAll('iframe[data-script-sandbox]')
    // Nothing in jsdom ever answers the handshake, so the run stays pending
    // until it is cancelled — which is also what has to take the frame down.
    await vi.waitFor(() => expect(sandboxes()).toHaveLength(1))
    run.abort()
    await expect(run.outputs).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(sandboxes()).toHaveLength(0))
  })

  it('ignores messages that arrive after the run settled', async () => {
    const worker = createFakeWorker({ run: () => [{ t: 'done', outputs: { n: 1 } }] })
    const h = makeHarness(worker)
    const run = start(h)
    await expect(run.outputs).resolves.toEqual({ n: 1 })

    const late: FromWorker = { t: 'log', line: 'zombie' }
    worker.emit(late)
    expect(h.onLog).not.toHaveBeenCalled()
    expect(worker.terminated).toBe(1)
  })
})
