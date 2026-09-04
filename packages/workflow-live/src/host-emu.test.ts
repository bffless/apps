import { describe, expect, it, vi } from 'vitest'
import { hostReply } from './host-emu.js'

describe('hostReply — the host side of the MCP Apps bridge', () => {
  it('answers ui/initialize with a host that proxies server tools and starts inline', async () => {
    const out = await hostReply({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'x', version: '0' }, appCapabilities: {} } }, vi.fn(), { impl: 'hello' })
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'workflow-live host-emu', version: '0.0.0' }, hostCapabilities: { serverTools: {}, serverResources: {} }, hostContext: { displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } } }])
  })
  it('sends tool-input on initialized, proxies tools/call, echoes request-display-mode, ignores notifications', async () => {
    const callTool = vi.fn(async () => ({ content: [] }))
    expect(await hostReply({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, callTool, { runId: 'r' })).toEqual([{ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { runId: 'r' } } }])
    expect(await hostReply({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'workflow.status', arguments: { runId: 'r' } } }, callTool, {})).toEqual([{ jsonrpc: '2.0', id: 7, result: { content: [] } }])
    expect(callTool).toHaveBeenCalledWith({ name: 'workflow.status', arguments: { runId: 'r' } })
    expect(await hostReply({ jsonrpc: '2.0', id: 8, method: 'ui/request-display-mode', params: { mode: 'fullscreen' } }, callTool, {})).toEqual([{ jsonrpc: '2.0', id: 8, result: { mode: 'fullscreen' } }])
    expect(await hostReply({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 300 } }, callTool, {})).toEqual([])
  })
})
