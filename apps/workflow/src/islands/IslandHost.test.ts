/**
 * The island host (04, Decisions 9–11): the MCP Apps *host* half of an
 * interactive step, driven against the real `@modelcontextprotocol/ext-apps`
 * `App` class (see `fakeIsland.ts`) over an in-memory transport. Every
 * assertion below is a real JSON-RPC round trip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeIsland } from './fakeIsland'
import { createIslandHost, IslandLoadError, IslandMountAbandoned } from './IslandHost'
import type { IslandHost, IslandHostDeps } from './IslandHost'

const HTML = '<!doctype html><html><body>island</body></html>'

/** The `mount` argument a hello island step would produce (Task 3's `islandInputs`). */
const MOUNT = {
  impl: 'hello',
  src: 'islands/editor.html',
  arguments: { lines: ['a', 'b'] },
  headless: false,
  get signal() {
    return new AbortController().signal
  },
}

interface Harness {
  host: IslandHost
  iframe: HTMLIFrameElement
  island: ReturnType<typeof createFakeIsland>
  http: ReturnType<typeof vi.fn>
  fetchText: ReturnType<typeof vi.fn>
  onSubmit: ReturnType<typeof vi.fn>
  onAnnotate: ReturnType<typeof vi.fn>
  sign: ReturnType<typeof vi.fn>
  onDisplayMode: ReturnType<typeof vi.fn>
  onLog: ReturnType<typeof vi.fn>
  openLink: ReturnType<typeof vi.fn>
}

const frames: HTMLIFrameElement[] = []

function makeHarness(over: Partial<IslandHostDeps> = {}, island = createFakeIsland()): Harness {
  const iframe = document.createElement('iframe')
  document.body.append(iframe)
  frames.push(iframe)

  const http = vi.fn(async () => ({ status: 200, ok: true, body: { greeting: 'hi' } }))
  const fetchText = vi.fn(async () => ({ ok: true, status: 200, text: HTML }))
  const onSubmit = vi.fn(() => ({ ok: true }) as const)
  const onAnnotate = vi.fn(() => ({ ok: true }) as const)
  const sign = vi.fn(async () => ({ url: 'https://bucket.example/poster.svg?sig=1', expiresIn: 3600 }))
  const onDisplayMode = vi.fn()
  const onLog = vi.fn()
  const openLink = vi.fn()

  const host = createIslandHost({
    http: http as unknown as IslandHostDeps['http'],
    fetchText: fetchText as unknown as IslandHostDeps['fetchText'],
    onSubmit: onSubmit as unknown as IslandHostDeps['onSubmit'],
    onAnnotate: onAnnotate as unknown as IslandHostDeps['onAnnotate'],
    sign: sign as unknown as IslandHostDeps['sign'],
    onDisplayMode,
    onLog,
    openLink,
    now: () => Date.now(),
    transport: island.transport,
    ...over,
  })

  return { host, iframe, island, http, fetchText, onSubmit, onAnnotate, sign, onDisplayMode, onLog, openLink }
}

async function mounted(
  over: Partial<IslandHostDeps> = {},
  args: Partial<Parameters<IslandHost['mount']>[1]> = {},
  island = createFakeIsland(),
): Promise<Harness> {
  const h = makeHarness(over, island)
  const mounting = h.host.mount(h.iframe, { ...MOUNT, ...args })
  await h.island.connect()
  await mounting
  return h
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The first text block of a tool result — MCP's content list is a union. */
function firstText(result: { content?: unknown }): string {
  const blocks = result.content as { type: string; text?: string }[] | undefined
  return blocks?.[0]?.text ?? ''
}

afterEach(() => {
  for (const frame of frames.splice(0)) frame.remove()
})

// ---------------------------------------------------------------------------
// (a) mount
// ---------------------------------------------------------------------------

describe('mount', () => {
  it('fetches the HTML, injects it as srcdoc and resolves after ui/notifications/initialized', async () => {
    const h = await mounted()

    expect(h.fetchText).toHaveBeenCalledWith('/w/hello/islands/editor.html')
    expect(h.iframe.srcdoc).toBe(HTML)
    expect(h.island.frames).toEqual([h.iframe])
  })

  it('sends the step arguments as ui/notifications/tool-input', async () => {
    const h = await mounted()
    await tick()

    expect(h.island.toolInputs).toHaveLength(1)
    expect(h.island.toolInputs[0].arguments).toEqual({ lines: ['a', 'b'] })
  })

  it('hands the View a host context with a theme, the display mode and the platform', async () => {
    const h = await mounted()
    const context = h.island.app.getHostContext()

    expect(context).toMatchObject({ displayMode: 'inline', platform: 'web' })
    expect(context?.theme === 'light' || context?.theme === 'dark').toBe(true)
  })

  // apps#363: `render: island` (IslandView) hands its `decl.src` to this same
  // `mount` unresolved — `resolveSrc` is the one bundle-escape fence, whether
  // the src came from a step's `with.src` or a value declaration. A src that
  // escapes the bundle throws synchronously inside the async `mount`, so it
  // rejects without ever fetching HTML or writing `srcdoc` — no iframe content
  // is ever mounted. `IslandFrame` turns that rejection into `onLoadError`
  // rather than an uncaught throw; a viewer (`IslandView`) treats that as a
  // no-op and stays an empty frame, never mounted (its own doc comment).
  it.each(['//evil.example/x.html', 'https://evil.example/x.html'])(
    'rejects without mounting for a src that escapes the bundle (%s)',
    async (src) => {
      const h = makeHarness()

      await expect(h.host.mount(h.iframe, { ...MOUNT, src })).rejects.toThrow()

      expect(h.fetchText).not.toHaveBeenCalled()
      expect(h.iframe.srcdoc).toBe('')
    },
  )
})

// ---------------------------------------------------------------------------
// (b), (c) tools/call → pipelines
// ---------------------------------------------------------------------------

describe('tools/call → a pipeline', () => {
  it('POSTs the arguments to the implementation rule and returns the JSON as structuredContent', async () => {
    const h = await mounted()

    const result = await h.island.app.callServerTool({ name: 'echo', arguments: { say: 'hi' } })

    expect(h.http).toHaveBeenCalledTimes(1)
    expect(h.http.mock.calls[0][0]).toBe('/api/hello/echo')
    expect(h.http.mock.calls[0][1]).toMatchObject({ method: 'POST', body: { say: 'hi' } })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ greeting: 'hi' })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ greeting: 'hi' }) }])
  })

  it('sends the arguments as a query string when the island asks for GET', async () => {
    const h = await mounted()

    await h.island.app.callServerTool({
      name: 'greet.lines',
      arguments: { n: 2 },
      _meta: { bffless: { method: 'GET' } },
    })

    expect(h.http.mock.calls[0][0]).toBe('/api/hello/greet/lines')
    expect(h.http.mock.calls[0][1]).toMatchObject({ method: 'GET', query: { n: 2 } })
  })

  it('turns a non-2xx into a tool error carrying the status', async () => {
    const h = await mounted()
    h.http.mockResolvedValueOnce({
      status: 500,
      ok: false,
      body: { code: 'BOOM', message: 'kaput' },
    } as never)

    const result = await h.island.app.callServerTool({ name: 'echo', arguments: {} })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'BOOM: kaput' }])
    expect(result._meta).toMatchObject({ bffless: { status: 500 } })
  })

  it('rejects a tool name that escapes the implementation without calling http', async () => {
    const h = await mounted()

    const result = await h.island.app.callServerTool({ name: '/api/other/x', arguments: {} })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('/api/other/x')
    expect(h.http).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// (d), (e) the host tools
// ---------------------------------------------------------------------------

describe('tools/call → the host tools', () => {
  it('routes workflow.submit to onSubmit', async () => {
    const h = await mounted()

    const result = await h.island.app.callServerTool({
      name: 'workflow.submit',
      arguments: { outputs: { spans: [1, 2] } },
    })

    expect(h.onSubmit).toHaveBeenCalledWith({ spans: [1, 2] })
    expect(result.isError).toBeFalsy()
  })

  it('returns a rejected submit as the tool error and leaves the step alone', async () => {
    const errors = { spans: 'Required' }
    const h = await mounted()
    h.onSubmit.mockReturnValueOnce({ ok: false, errors } as never)

    const result = await h.island.app.callServerTool({
      name: 'workflow.submit',
      arguments: { outputs: {} },
    })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(errors) }])
    expect(result.structuredContent).toEqual({ errors })
  })

  it('routes workflow.annotate to onAnnotate and reports its rejection', async () => {
    const h = await mounted()

    await h.island.app.callServerTool({
      name: 'workflow/annotate',
      arguments: { summary: 'done' },
    })
    expect(h.onAnnotate).toHaveBeenCalledWith({ summary: 'done' })

    h.onAnnotate.mockReturnValueOnce({ ok: false, error: '`summary` must be a string' } as never)
    const bad = await h.island.app.callServerTool({ name: 'workflow.annotate', arguments: {} })
    expect(bad.isError).toBe(true)
    expect(firstText(bad)).toContain('`summary` must be a string')
  })

  it('routes workflow.sign to deps.sign and answers with the presigned url', async () => {
    const h = await mounted()

    const result = await h.island.app.callServerTool({
      name: 'workflow.sign',
      arguments: { path: 'workflows/hello/interactive/runs/run_1/poster.svg' },
    })

    expect(h.sign).toHaveBeenCalledWith('workflows/hello/interactive/runs/run_1/poster.svg')
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({
      url: 'https://bucket.example/poster.svg?sig=1',
      expiresIn: 3600,
    })
    expect(firstText(result)).toBe('https://bucket.example/poster.svg?sig=1')
  })

  it('reports a refused or failed sign as a tool error', async () => {
    const h = await mounted()
    h.sign.mockRejectedValueOnce(new Error('path must be under workflows/'))

    const result = await h.island.app.callServerTool({
      name: 'workflow/sign',
      arguments: { path: '../secrets' },
    })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('path must be under workflows/')
  })

  it('lets a viewer sign — a render: island viewer showing media needs it', async () => {
    const h = await mounted({}, { viewer: true, arguments: { value: { path: 'workflows/x/p.svg' } } })

    const result = await h.island.app.callServerTool({
      name: 'workflow.sign',
      arguments: { path: 'workflows/x/p.svg' },
    })

    expect(result.isError).toBeFalsy()
    expect(h.sign).toHaveBeenCalledWith('workflows/x/p.svg')
  })

  it('rejects workflow.submit in viewer mode without calling onSubmit', async () => {
    const h = await mounted({}, { viewer: true, arguments: { value: { spans: [] } } })

    const result = await h.island.app.callServerTool({
      name: 'workflow.submit',
      arguments: { outputs: {} },
    })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('read-only viewer')
    expect(h.onSubmit).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// (f) resources/read, and the rest of the host surface
// ---------------------------------------------------------------------------

describe('the host surface', () => {
  it('serves resources/read ui://bffless/<impl>/… from the implementation bundle', async () => {
    const h = await mounted()
    h.fetchText.mockResolvedValueOnce({ ok: true, status: 200, text: 'body{}' } as never)

    const result = await h.island.app.readServerResource({
      uri: 'ui://bffless/hello/islands/a.css',
    })

    expect(h.fetchText).toHaveBeenLastCalledWith('/w/hello/islands/a.css')
    expect(result.contents).toEqual([
      { uri: 'ui://bffless/hello/islands/a.css', mimeType: 'text/css', text: 'body{}' },
    ])
  })

  it('refuses a resource uri for another scheme or another implementation', async () => {
    const h = await mounted()

    await expect(h.island.app.readServerResource({ uri: 'https://evil.test/x' })).rejects.toThrow()
    await expect(
      h.island.app.readServerResource({ uri: 'ui://bffless/other/islands/a.css' }),
    ).rejects.toThrow()
  })

  it('answers ui/request-display-mode with the mode it applied and tells the app', async () => {
    const h = await mounted()

    expect(await h.island.app.requestDisplayMode({ mode: 'fullscreen' })).toEqual({
      mode: 'fullscreen',
    })
    expect(h.onDisplayMode).toHaveBeenCalledWith('fullscreen')

    // `pip` is not offered: the host answers with the mode already in force.
    expect(await h.island.app.requestDisplayMode({ mode: 'pip' })).toEqual({ mode: 'fullscreen' })
    expect(h.onDisplayMode).toHaveBeenCalledTimes(1)
  })

  it('opens a safe link and refuses an unsafe one', async () => {
    const h = await mounted()

    expect(await h.island.app.openLink({ url: 'https://bffless.dev' })).toEqual({})
    expect(h.openLink).toHaveBeenCalledWith('https://bffless.dev')

    const blocked = await h.island.app.openLink({ url: 'data:text/html,<b>x</b>' })
    expect(blocked).toMatchObject({ isError: true })
    expect(h.openLink).toHaveBeenCalledTimes(1)
  })

  it('logs ui/message content and notifications/message data to the step card', async () => {
    const h = await mounted()

    await h.island.app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'from ui' }] })
    await h.island.app.sendLog({ level: 'info', data: 'from log' })
    await tick()

    expect(h.onLog.mock.calls.map((c) => c[0])).toEqual(['from ui', 'from log'])
  })

  it('accepts and ignores ui/update-model-context', async () => {
    const h = await mounted()

    await expect(
      h.island.app.updateModelContext({ content: [{ type: 'text', text: 'ctx' }] }),
    ).resolves.toBeDefined()
  })

  it('grows the frame on size-changed while inline, capped at 80vh', async () => {
    const h = await mounted()

    await h.island.app.sendSizeChanged({ height: 320 })
    await tick()
    expect(h.iframe.style.height).toBe('320px')

    await h.island.app.sendSizeChanged({ height: 100000 })
    await tick()
    expect(h.iframe.style.height).toBe(`${Math.round(window.innerHeight * 0.8)}px`)
  })

  it('clears the inline height on the way into fullscreen and ignores size-changed there', async () => {
    const h = await mounted()

    await h.island.app.sendSizeChanged({ height: 320 })
    await tick()
    expect(h.iframe.style.height).toBe('320px')

    // The inline height is an inline style: left in place it would beat
    // `.island-fullscreen .island-frame { height: 100% }`.
    await h.island.app.requestDisplayMode({ mode: 'fullscreen' })
    expect(h.iframe.style.height).toBe('')

    await h.island.app.sendSizeChanged({ height: 400 })
    await tick()
    expect(h.iframe.style.height).toBe('')
  })

  it('lets the page put the island back inline, and tells the View it happened', async () => {
    const h = await mounted()
    await h.island.app.requestDisplayMode({ mode: 'fullscreen' })
    await tick()
    expect(h.island.app.getHostContext()?.displayMode).toBe('fullscreen')

    h.host.setDisplayMode('inline')
    await tick()

    expect(h.island.app.getHostContext()?.displayMode).toBe('inline')
    expect(h.island.contextChanges.at(-1)).toEqual({ displayMode: 'inline' })
    // ...and the frame follows size-changed again.
    await h.island.app.sendSizeChanged({ height: 200 })
    await tick()
    expect(h.iframe.style.height).toBe('200px')
  })

  it('applies a mode set before the bridge connects through ui/initialize, with no unhandled rejection', async () => {
    // Fix round 4, finding 2: the pane registers a session synchronously, so
    // `RunPage`'s `display: fullscreen` seed lands while the HTML fetch is
    // still in flight. Sending `host-context-changed` there would reject with
    // `Not connected` inside ext-apps, which discards the promise — an
    // unhandled rejection on every fullscreen island. The mode has to ride the
    // handshake instead.
    const rejections: unknown[] = []
    const onRejection = (err: unknown) => rejections.push(err)
    process.on('unhandledRejection', onRejection)

    try {
      let release!: (html: { ok: boolean; status: number; text: string }) => void
      const pending = new Promise<{ ok: boolean; status: number; text: string }>((resolve) => {
        release = resolve
      })
      const h = makeHarness({
        fetchText: (() => pending) as unknown as IslandHostDeps['fetchText'],
      })

      const mounting = h.host.mount(h.iframe, MOUNT)
      await tick()
      h.host.setDisplayMode('fullscreen')
      await tick()
      await tick()
      expect(rejections).toEqual([])

      release({ ok: true, status: 200, text: HTML })
      await h.island.connect()
      await mounting
      await tick()

      // It arrived as part of `ui/initialize`, not as a notification.
      expect(h.island.app.getHostContext()?.displayMode).toBe('fullscreen')
      expect(h.island.contextChanges).toEqual([])
      expect(rejections).toEqual([])

      // And the connected path still notifies, from that same mode.
      h.host.setDisplayMode('inline')
      await tick()
      expect(h.island.contextChanges).toEqual([{ displayMode: 'inline' }])
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('setDisplayMode is a no-op when nothing changed, before a mount, and after teardown', async () => {
    const before = makeHarness()
    expect(() => before.host.setDisplayMode('fullscreen')).not.toThrow()

    const h = await mounted()
    h.host.setDisplayMode('inline')
    await tick()
    expect(h.island.contextChanges).toEqual([])

    h.host.setDisplayMode('fullscreen')
    await tick()
    expect(h.island.contextChanges).toEqual([{ displayMode: 'fullscreen' }])

    await h.host.teardown('completed')
    h.host.setDisplayMode('inline')
    await tick()
    expect(h.island.contextChanges).toEqual([{ displayMode: 'fullscreen' }])
  })
})

// ---------------------------------------------------------------------------
// (g) ISLAND_LOAD
// ---------------------------------------------------------------------------

describe('ISLAND_LOAD', () => {
  it('rejects when the island HTML is not 2xx, and never touches the frame', async () => {
    const h = makeHarness()
    h.fetchText.mockResolvedValueOnce({ ok: false, status: 404, text: 'not found' } as never)

    const err = await h.host
      .mount(h.iframe, MOUNT)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(IslandLoadError)
    expect((err as IslandLoadError).code).toBe('ISLAND_LOAD')
    expect((err as IslandLoadError).message).toContain('404')
    expect(h.iframe.srcdoc).toBe('')
  })

  it('rejects when the View never sends ui/initialize within 30 s', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness()
      const mounting = h.host.mount(h.iframe, MOUNT)
      const settled = mounting.catch((e: unknown) => e)

      await vi.advanceTimersByTimeAsync(29_000)
      await vi.advanceTimersByTimeAsync(2_000)

      const err = await settled
      expect(err).toBeInstanceOf(IslandLoadError)
      expect((err as IslandLoadError).message).toContain('30')
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons — does not fail — when the mount is aborted before the View initializes', async () => {
    const h = makeHarness()
    const controller = new AbortController()
    const settled = h.host
      .mount(h.iframe, { ...MOUNT, signal: controller.signal })
      .catch((e: unknown) => e)

    await tick()
    controller.abort()

    expect(await settled).toBeInstanceOf(IslandMountAbandoned)
  })

  it('keeps abandonment and load failure disjoint', async () => {
    // The whole point of the two types: a caller asking "is this the step's
    // failure?" gets the right answer without reading the message.
    const h = makeHarness()
    h.fetchText.mockResolvedValueOnce({ ok: false, status: 500, text: 'boom' } as never)
    const failure = await h.host.mount(h.iframe, MOUNT).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(IslandLoadError)
    expect(failure).not.toBeInstanceOf(IslandMountAbandoned)
    expect((failure as IslandLoadError).code).toBe('ISLAND_LOAD')

    const other = makeHarness()
    const controller = new AbortController()
    controller.abort()
    const abandoned = await other.host
      .mount(other.iframe, { ...MOUNT, signal: controller.signal })
      .catch((e: unknown) => e)

    expect(abandoned).toBeInstanceOf(IslandMountAbandoned)
    expect(abandoned).not.toBeInstanceOf(IslandLoadError)
    expect((abandoned as IslandMountAbandoned).code).toBe('ISLAND_ABANDONED')
  })
})

// ---------------------------------------------------------------------------
// (h) teardown
// ---------------------------------------------------------------------------

describe('teardown', () => {
  it('sends ui/resource-teardown and disconnects', async () => {
    const h = await mounted()

    await h.host.teardown('cancelled')

    expect(h.island.teardowns).toBe(1)
    expect(h.island.closed).toBe(true)
  })

  it('is idempotent, and safe before a mount', async () => {
    const before = makeHarness()
    await expect(before.host.teardown('unmounted')).resolves.toBeUndefined()

    const h = await mounted()
    await h.host.teardown('completed')
    await h.host.teardown('completed')

    expect(h.island.teardowns).toBe(1)
  })

  it('still disconnects when the island never registered an onteardown handler', async () => {
    const island = createFakeIsland({ teardown: false })
    const h = await mounted({}, {}, island)

    await expect(h.host.teardown('cancelled')).resolves.toBeUndefined()
    expect(island.closed).toBe(true)
  })

  it('abandons an already-aborted mount without fetching the HTML', async () => {
    const h = makeHarness()
    const controller = new AbortController()
    controller.abort()

    const err = await h.host
      .mount(h.iframe, { ...MOUNT, signal: controller.signal })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(IslandMountAbandoned)
    expect(h.fetchText).not.toHaveBeenCalled()
    expect(h.iframe.srcdoc).toBe('')
  })

  it('a teardown during the HTML fetch abandons the mount before it can connect', async () => {
    const island = createFakeIsland()
    let deliver: (html: { ok: boolean; status: number; text: string }) => void = () => {}
    const fetchText = vi.fn(
      () =>
        new Promise<{ ok: boolean; status: number; text: string }>((resolve) => {
          deliver = resolve
        }),
    )
    const h = makeHarness({ fetchText: fetchText as unknown as IslandHostDeps['fetchText'] }, island)

    const settled = h.host.mount(h.iframe, MOUNT).catch((e: unknown) => e)
    await tick()
    await h.host.teardown('cancelled')
    deliver({ ok: true, status: 200, text: HTML })

    expect(await settled).toBeInstanceOf(IslandMountAbandoned)
    expect(h.iframe.srcdoc).toBe('')
    // The transport is only built at `connect()` time: never reached.
    expect(island.frames).toEqual([])
  })

  it('a mount superseded while its HTML is in flight never connects its bridge', async () => {
    const survivor = createFakeIsland()
    const pending: ((html: { ok: boolean; status: number; text: string }) => void)[] = []
    const fetchText = vi.fn(
      () =>
        new Promise<{ ok: boolean; status: number; text: string }>((resolve) => {
          pending.push(resolve)
        }),
    )
    const h = makeHarness(
      { fetchText: fetchText as unknown as IslandHostDeps['fetchText'] },
      survivor,
    )

    const first = h.host.mount(h.iframe, MOUNT).catch((e: unknown) => e)
    await tick()
    const second = h.host.mount(h.iframe, MOUNT)
    await tick()
    expect(pending).toHaveLength(2)

    pending[0]({ ok: true, status: 200, text: HTML })
    expect(await first).toBeInstanceOf(IslandMountAbandoned)

    pending[1]({ ok: true, status: 200, text: HTML })
    await survivor.connect()
    await second

    // Exactly one bridge ever connected, and it is the second one.
    expect(survivor.frames).toEqual([h.iframe])
    expect(survivor.closed).toBe(false)
    const result = await survivor.app.callServerTool({ name: 'echo', arguments: {} })
    expect(result.isError).toBeFalsy()
  })

  it('a second mount supersedes the first rather than leaving two bridges connected', async () => {
    const first = createFakeIsland()
    const second = createFakeIsland()
    const queue = [first, second]
    const h = makeHarness({ transport: (iframe) => queue.shift()!.transport(iframe) })

    const firstMount = h.host.mount(h.iframe, MOUNT)
    await first.connect()
    await firstMount

    const secondMount = h.host.mount(h.iframe, MOUNT)
    await second.connect()
    await secondMount

    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// apps#370 — host polish follow-ups
// ---------------------------------------------------------------------------

/** Collect unhandled rejections for the duration of `run`. */
async function withRejections(run: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = []
  const onRejection = (err: unknown) => rejections.push(err)
  process.on('unhandledRejection', onRejection)
  try {
    await run()
    await tick()
    await tick()
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  return rejections
}

describe('sendToolInput (#370)', () => {
  it('re-sends tool-input to a viewer without remounting', async () => {
    const h = await mounted({}, { viewer: true, arguments: { value: 1 } })
    await tick()

    await h.host.sendToolInput({ value: 2 })
    await tick()

    expect(h.island.toolInputs.map((t) => t.arguments)).toEqual([{ value: 1 }, { value: 2 }])
    expect(h.fetchText).toHaveBeenCalledTimes(1)
    expect(h.island.frames).toHaveLength(1)
  })

  it("never re-sends to a step's island", async () => {
    const h = await mounted()
    await tick()

    await expect(h.host.sendToolInput({ lines: [] })).rejects.toThrow(/viewer/)
    await tick()
    expect(h.island.toolInputs).toHaveLength(1)
  })

  it('is a no-op before a mount and after teardown', async () => {
    const before = makeHarness()
    await expect(before.host.sendToolInput({ value: 1 })).resolves.toBeUndefined()

    const h = await mounted({}, { viewer: true })
    await h.host.teardown('unmounted')
    await expect(h.host.sendToolInput({ value: 1 })).resolves.toBeUndefined()
  })

  it('is a no-op while the mount is still delivering its own tool-input, so order holds', async () => {
    // Between `bridge.connect` and the mount's own send there is a transport
    // to notify over — but sending here would put the new value *before* the
    // mount's, leaving the island on the stale one. The frame re-checks after
    // the mount resolves, so dropping the call loses nothing.
    const h = makeHarness()
    const mounting = h.host.mount(h.iframe, { ...MOUNT, viewer: true, arguments: { value: 1 } })
    await tick()
    await tick()
    await h.host.sendToolInput({ value: 2 })

    await h.island.connect()
    await mounting
    await tick()

    expect(h.island.toolInputs.map((t) => t.arguments)).toEqual([{ value: 1 }])
  })

  it("rejects for a step's island even before it is connected", async () => {
    const h = makeHarness()
    const mounting = h.host.mount(h.iframe, MOUNT)
    await tick()
    await expect(h.host.sendToolInput({ lines: [] })).rejects.toThrow(/viewer/)
    await h.island.connect()
    await mounting
  })
})

describe('host context follows the page (#370)', () => {
  interface FakeMediaQuery {
    matches: boolean
    listeners: ((e: { matches: boolean }) => void)[]
    addEventListener(type: string, fn: (e: { matches: boolean }) => void): void
    removeEventListener(type: string, fn: (e: { matches: boolean }) => void): void
  }

  function stubMatchMedia(matches: boolean): FakeMediaQuery {
    const query: FakeMediaQuery = {
      matches,
      listeners: [],
      addEventListener: (_type, fn) => query.listeners.push(fn),
      removeEventListener: (_type, fn) => {
        query.listeners = query.listeners.filter((l) => l !== fn)
      },
    }
    vi.stubGlobal('matchMedia', () => query)
    return query
  }

  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = []
    observed: Element[] = []
    disconnected = false
    callback: () => void
    constructor(callback: () => void) {
      this.callback = callback
      FakeResizeObserver.instances.push(this)
    }
    observe(el: Element) {
      this.observed.push(el)
    }
    disconnect() {
      this.disconnected = true
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    FakeResizeObserver.instances = []
  })

  it('tells a connected island when the OS theme flips', async () => {
    const query = stubMatchMedia(false)
    const h = await mounted()
    expect(h.island.app.getHostContext()?.theme).toBe('light')

    query.matches = true
    for (const fn of query.listeners) fn({ matches: true })
    await tick()

    expect(h.island.contextChanges.at(-1)).toEqual({ theme: 'dark' })
    expect(h.island.app.getHostContext()?.theme).toBe('dark')
  })

  it('tells a connected island when the frame is resized', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const h = await mounted()
    const observer = FakeResizeObserver.instances.at(-1)
    expect(observer?.observed).toEqual([h.iframe])

    h.iframe.getBoundingClientRect = () => ({ width: 640 }) as DOMRect
    observer!.callback()
    await tick()

    expect(h.island.contextChanges.at(-1)).toEqual({
      containerDimensions: { width: 640, maxHeight: Math.round(window.innerHeight * 0.8) },
    })
  })

  it('stops observing on teardown', async () => {
    const query = stubMatchMedia(false)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const h = await mounted()
    expect(query.listeners).toHaveLength(1)

    await h.host.teardown('completed')

    expect(query.listeners).toHaveLength(0)
    expect(FakeResizeObserver.instances.at(-1)?.disconnected).toBe(true)
  })
})

describe('an out-of-band transport death (#370)', () => {
  it('clears the connected flag, so a later setDisplayMode neither notifies nor rejects', async () => {
    const h = await mounted()

    const rejections = await withRejections(async () => {
      await h.island.killHostTransport()
      h.host.setDisplayMode('fullscreen')
    })

    expect(rejections).toEqual([])
    expect(h.island.contextChanges).toEqual([])
  })
})
