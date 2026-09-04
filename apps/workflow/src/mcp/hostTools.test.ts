// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HOST_TOOLS, HOST_TOOL_SCOPES, RESOURCE_MIME, SERVER_VERSION, STEP_VIEW_URI, isHostTool } from './hostTools'

describe('the app-only tools', () => {
  it('map to the run scope except the read-only step view (Phase 3 plan, Decision 26)', () => {
    expect(HOST_TOOL_SCOPES).toEqual({ 'workflow.submit': 'workflow:run', 'workflow.annotate': 'workflow:run', 'workflow.pipeline': 'workflow:run', 'workflow.stepView': 'workflow:read' })
    expect(HOST_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(HOST_TOOL_SCOPES).sort())
  })

  it('marks every host tool app-only and run/step scoped', () => {
    for (const tool of HOST_TOOLS) {
      expect(tool._meta.ui.visibility).toEqual(['app'])
      expect(tool.inputSchema.required.slice(0, 2)).toEqual(['runId', 'step'])
      expect(isHostTool(tool.name)).toBe(true)
    }
    expect(isHostTool('workflow.sign')).toBe(false)
  })

  it("announces the island host's protocol version", async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../islands/IslandHost.ts', import.meta.url), 'utf8'))
    const hostInfo = source.match(/const HOST_INFO = \{ name: '[^']+', version: '([^']+)' \}/)
    expect(hostInfo?.[1]).toBe(SERVER_VERSION)
  })

  it('names the MCP Apps MIME type and the step view', () => {
    expect(RESOURCE_MIME).toBe('text/html;profile=mcp-app')
    expect(STEP_VIEW_URI).toBe('ui://bffless/workflow/step.html')
  })
})
