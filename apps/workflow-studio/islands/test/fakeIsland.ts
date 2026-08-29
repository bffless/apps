/**
 * The HOST half of the island bridge, for an island's own unit tests.
 *
 * Adapted from the harness's `apps/workflow/src/islands/fakeIsland.ts` — **inverted**.
 * That file is the *View* side (a real `@modelcontextprotocol/ext-apps` `App` driven
 * over `InMemoryTransport`) so that tests of `IslandHost` exercise a real island; here
 * the subject under test *is* the View, so what a test has to supply is the other end:
 * something that answers `callServerTool` and carries a host context.
 *
 * What changed, and why not the real `App` over a linked transport:
 *
 * - **Direction.** `createFakeIsland()` → `createFakeHost()`. The harness's version
 *   hands the test an `App`; this one hands the test the object an island's `Editor`
 *   takes as its `bridge` prop.
 * - **No transport.** The real `App` needs a *host* on the other end that answers
 *   `ui/initialize`, `tools/call` and the host-context notification — i.e. the
 *   harness's own `createIslandHost`, which lives in another app and is not this
 *   app's to import. The wire itself is already proven there (`IslandHost.test.ts`
 *   asserts every one of those round trips against the real `App`); what is left to
 *   prove here is the *island's* behaviour given a host, so the fake stops at the
 *   two methods `IslandBridge` declares.
 * - **The fidelity anchor is the type.** `main.tsx` passes the real `App` as the
 *   `bridge`, so `IslandBridge` must stay structurally satisfied by it — a change to
 *   the SDK's `callServerTool`/`getHostContext` signature fails `tsc`, not silently a
 *   test.
 * - **Recording + scripting.** `calls` keeps every `{ name, arguments }` in order (the
 *   harness's `toolInputs`/`teardowns` counters play the same role), and `answer()`
 *   scripts one tool name — including a tool *error*, which the host reports as an
 *   `isError` result rather than a rejection (04), and a rejection, which is what a
 *   transport failure reads as.
 */
import type { IslandBridge, ToolResult } from '../cut-editor/useSigned'

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface FakeHost extends IslandBridge {
  /** Every `callServerTool` the island made, in order. */
  calls: ToolCall[]
  /** The calls for one tool name, in order. */
  callsTo(name: string): ToolCall[]
  /** The `outputs` of the last `workflow.submit` (undefined if it never submitted). */
  lastSubmit(): Record<string, unknown> | undefined
  /**
   * Script one tool. The answer may be a result (`isError` for a refusal) or a
   * thrown/rejected error (a transport failure). Replaces any previous script for
   * that name.
   */
  answer(name: string, reply: (call: ToolCall) => ToolResult | Promise<ToolResult>): void
}

export interface FakeHostOptions {
  /**
   * What `getHostContext()` returns. The harness always sends one (theme, display
   * mode, platform, and `bffless.headless` on a headless run); `undefined` models an
   * island rendered before the context arrived.
   */
  hostContext?: unknown
  /** Shorthand for a host context whose `bffless.headless` is true. */
  headless?: boolean
}

/** The default `workflow.sign` answer: a presigned URL derived from the path. */
const signed = (path: string): ToolResult => ({
  content: [{ type: 'text', text: `https://bucket.example/${path}?sig=1` }],
  structuredContent: { url: `https://bucket.example/${path}?sig=1`, expiresIn: 3600 },
})

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const scripted = new Map<string, (call: ToolCall) => ToolResult | Promise<ToolResult>>()

  const context =
    options.hostContext ?? (options.headless ? { bffless: { headless: true } } : { bffless: {} })

  const host: FakeHost = {
    calls: [],
    callsTo: (name) => host.calls.filter((c) => c.name === name),
    lastSubmit: () => {
      const submits = host.callsTo('workflow.submit')
      const last = submits[submits.length - 1]
      return last ? (last.arguments.outputs as Record<string, unknown>) : undefined
    },
    answer: (name, reply) => {
      scripted.set(name, reply)
    },
    getHostContext: () => context,
    callServerTool: async (request) => {
      const call: ToolCall = { name: request.name, arguments: request.arguments ?? {} }
      host.calls.push(call)

      const script = scripted.get(call.name)
      if (script) return await script(call)

      if (call.name === 'workflow.sign') return signed(String(call.arguments.path ?? ''))
      if (call.name === 'workflow.submit') return { content: [{ type: 'text', text: 'ok' }] }
      return { isError: true, content: [{ type: 'text', text: `no such tool: ${call.name}` }] }
    },
  }

  return host
}

/** A refused tool call, shaped the way `IslandHost` reports one (04). */
export const toolError = (message: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
})
