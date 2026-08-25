/**
 * The View side of the MCP Apps handshake, for unit tests.
 *
 * It is **not** a hand-rolled protocol fake: it is the real
 * `@modelcontextprotocol/ext-apps` `App` class — the same class an island
 * author imports — driven over `InMemoryTransport.createLinkedPair()`. So the
 * host under test answers real `ui/initialize`, real `tools/call`, real
 * `ui/request-display-mode` frames, and a change in the SDK's wire behaviour
 * fails these tests rather than passing a sympathetic double.
 *
 * Why not a fake iframe `Window` over a `MessageChannel`: jsdom refuses a plain
 * object as `MessageEvent.source` (so `PostMessageTransport`'s `event.source`
 * filter drops everything), and `PostMessageTransport.send` posts with `"*"`
 * where a `MessagePort` wants a transfer list. The postMessage/srcdoc path is
 * therefore proven in a real browser (Task 7's dev run, Task 8's Playwright
 * smoke), and the protocol itself is proven here through `IslandHostDeps.transport`.
 */
import { App } from '@modelcontextprotocol/ext-apps'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpUiToolInputNotification } from '@modelcontextprotocol/ext-apps/app-bridge'

export interface FakeIsland {
  /** The real View object — `callServerTool`, `readServerResource`, `requestDisplayMode`, … */
  app: App
  /** Pass as `IslandHostDeps.transport`; records every iframe the host mounted into. */
  transport: (iframe: HTMLIFrameElement) => Transport
  /** The iframes the host handed the transport factory, in order. */
  frames: HTMLIFrameElement[]
  /** Every `ui/notifications/tool-input` the host sent, in order. */
  toolInputs: McpUiToolInputNotification['params'][]
  /** How many `ui/resource-teardown` requests the island answered. */
  teardowns: number
  /** The `params` of each teardown request, as the View's schema delivered them. */
  teardownParams: unknown[]
  /** True once the host closed the connection. */
  closed: boolean
  /** Every `ui/notifications/host-context-changed` diff the host sent. */
  contextChanges: Record<string, unknown>[]
  /** Run the View's `ui/initialize` handshake; resolves once the host has it. */
  connect(): Promise<void>
  /** Close the View side (an island whose page went away). */
  close(): Promise<void>
}

export interface FakeIslandOptions {
  name?: string
  version?: string
  /** `false` leaves `app.onteardown` unset — the island that answers method-not-found. */
  teardown?: boolean
}

/**
 * `InMemoryTransport` queues anything sent before the other end calls `start()`,
 * so the host and the View may connect in either order — the test does not have
 * to interleave `mount()` with `connect()`.
 */
export function createFakeIsland(options: FakeIslandOptions = {}): FakeIsland {
  const [hostTransport, appTransport] = InMemoryTransport.createLinkedPair()

  // `autoResize: false`: the App's default resize wiring needs a
  // `ResizeObserver`, which jsdom does not implement. Tests that care about
  // `ui/notifications/size-changed` send it explicitly.
  const app = new App(
    { name: options.name ?? 'fake-island', version: options.version ?? '1.0.0' },
    { tools: {} },
    { autoResize: false },
  )

  const island: FakeIsland = {
    app,
    frames: [],
    toolInputs: [],
    contextChanges: [],
    teardowns: 0,
    teardownParams: [],
    closed: false,
    transport: (iframe) => {
      island.frames.push(iframe)
      return hostTransport
    },
    connect: () => app.connect(appTransport),
    close: () => app.close(),
  }

  app.ontoolinput = (params) => {
    island.toolInputs.push(params)
  }
  app.onclose = () => {
    island.closed = true
  }
  // The App merges a host-context diff into `getHostContext()` only when the
  // `hostcontextchanged` event slot exists — the SDK creates notification
  // handlers lazily, on the first listener. A real island that cares about the
  // theme or the display mode registers one; so does this fake.
  app.addEventListener('hostcontextchanged', (params) => {
    island.contextChanges.push(params as Record<string, unknown>)
  })
  if (options.teardown !== false) {
    app.onteardown = (params) => {
      island.teardowns += 1
      island.teardownParams.push(params)
      return {}
    }
  }

  return island
}
