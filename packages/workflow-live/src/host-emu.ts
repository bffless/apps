/**
 * An emulated MCP Apps host (apps#586; Phase 4 plan, Decision 8): what
 * claude.ai does that no walk did before — a `sandbox="allow-scripts
 * allow-same-origin"` frame whose document is `document.write`n from the
 * resource text, and the host half of the ext-apps bridge as JSON-RPC over
 * postMessage: `ui/initialize` answered, `ui/notifications/tool-input` sent on
 * `initialized`, `tools/call` proxied to the live endpoint (with the walk's
 * Bearer token, through `callTool`), `ui/request-display-mode` echoed,
 * `size-changed` recorded. Nothing from `@modelcontextprotocol/ext-apps` is
 * bundled for the page: `hostReply` below is the whole protocol the walk needs,
 * unit-tested here and injected into the page as source.
 */
import type { FrameLocator, Page } from 'playwright'

export interface ToolCallParams { name: string; arguments?: Record<string, unknown> }
type Message = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown }

/** The host's answer(s) to one message from the app — pure, so it is testable and serialisable into the page. */
export async function hostReply(m: Message, callTool: (p: ToolCallParams) => Promise<unknown>, toolInput: Record<string, unknown>): Promise<Message[]> {
  if (m.method === 'ui/initialize') {
    return [{ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params as { protocolVersion?: string })?.protocolVersion ?? '2026-01-26', hostInfo: { name: 'workflow-live host-emu', version: '0.0.0' }, hostCapabilities: { serverTools: {}, serverResources: {} }, hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } } }]
  }
  if (m.method === 'ui/notifications/initialized') return [{ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: toolInput } }]
  if (m.method === 'tools/call') return [{ jsonrpc: '2.0', id: m.id, result: await callTool(m.params as unknown as ToolCallParams) }]
  if (m.method === 'ui/request-display-mode') return [{ jsonrpc: '2.0', id: m.id, result: { mode: (m.params as { mode?: string })?.mode ?? 'inline' } }]
  if (m.id !== undefined && m.method) return [{ jsonrpc: '2.0', id: m.id, result: {} }]
  return []
}

export const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><script>
${String(hostReply)}
window.__log = []; window.__heights = []; window.__frames = []
window.__mount = (html, toolInput) => {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  frame.setAttribute('data-emu-frame', String(window.__frames.length))
  frame.style.cssText = 'width:100%;height:900px;border:0'
  document.body.appendChild(frame)
  window.__frames.push(frame)
  window.addEventListener('message', async (e) => {
    if (e.source !== frame.contentWindow) return
    const m = e.data
    if (!m || m.jsonrpc !== '2.0') return
    window.__log.push(m.method ? m.method : 'reply ' + m.id)
    if (m.method === 'ui/notifications/size-changed' && m.params && typeof m.params.height === 'number') window.__heights.push(m.params.height)
    for (const out of await hostReply(m, window.__callTool, toolInput)) frame.contentWindow.postMessage(out, '*')
  })
  frame.contentDocument.open(); frame.contentDocument.write(html); frame.contentDocument.close()
}
</script></body></html>`

export interface EmulatedHost {
  /** Mount a ui:// resource's HTML in a fresh sandboxed frame and send `tool-input` once the app reports `initialized`. Resolves with the frame's locator once `ui/initialize` was answered — the `page.locator(iframe).contentFrame()` idiom the `hello`/`interactive` walks use, so `view.getByTestId(...)` and `view.locator('[data-testid="island"]').contentFrame()` (the nested island) both work. */
  mount(html: string, toolInput: Record<string, unknown>): Promise<FrameLocator>
  /** Every JSON-RPC method the app sent, in order (`ui/initialize`, `ui/notifications/initialized`, `tools/call`, `ui/notifications/size-changed …`). */
  log(): Promise<string[]>
  /** Every `size-changed` height received. */
  heights(): Promise<number[]>
}

export async function openEmulatedHost(page: Page, callTool: (params: ToolCallParams) => Promise<unknown>): Promise<EmulatedHost> {
  await page.exposeFunction('__callTool', callTool)
  await page.setContent(HOST_HTML)
  return {
    async mount(html, toolInput) {
      const index = await page.evaluate(([h, t]) => { window.__mount(h, t); return window.__frames.length - 1 }, [html, toolInput] as const)
      await page.waitForFunction((n) => window.__log.filter((l: string) => l === 'ui/initialize').length >= n, index + 1, { timeout: 30_000 })
      return page.locator(`iframe[data-emu-frame="${index}"]`).contentFrame()
    },
    log: () => page.evaluate(() => window.__log),
    heights: () => page.evaluate(() => window.__heights),
  }
}

declare global {
  interface Window {
    __log: string[]
    __heights: number[]
    __frames: HTMLIFrameElement[]
    __mount: (html: string, toolInput: Record<string, unknown>) => void
    __callTool: (p: ToolCallParams) => Promise<unknown>
  }
}
