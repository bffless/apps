// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RUN_SCOPE } from '@bffless/workflow-agent-tools'
import { HOST_TOOLS, HOST_TOOL_SCOPES, RESOURCE_MIME, SERVER_VERSION, STEP_VIEW_URI_PATTERN, isHostTool, stepViewUri } from './hostTools'

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

  /**
   * The step view only reads, so it takes the catalog's run `scope` (spec 11,
   * D27; apps#673) — the three tools that act on a step do not.
   */
  it('takes an asked-for scope on the step view alone', () => {
    const stepView = HOST_TOOLS.find((tool) => tool.name === 'workflow.stepView')!
    expect(stepView.inputSchema.properties.scope).toBe(RUN_SCOPE)
    expect(stepView.inputSchema.required).toEqual(['runId', 'step'])
    expect(stepView.inputSchema.additionalProperties).toBe(false)
    for (const tool of HOST_TOOLS.filter((tool) => tool.name !== 'workflow.stepView')) {
      expect(tool.inputSchema.properties.scope, tool.name).toBeUndefined()
    }
  })

  it("announces the island host's protocol version", async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../islands/IslandHost.ts', import.meta.url), 'utf8'))
    const hostInfo = source.match(/const HOST_INFO = \{ name: '[^']+', version: '([^']+)' \}/)
    expect(hostInfo?.[1]).toBe(SERVER_VERSION)
  })

  it('names the MCP Apps MIME type and a revisioned step-view URI (apps#587)', () => {
    expect(RESOURCE_MIME).toBe('text/html;profile=mcp-app')
    expect(stepViewUri('0123abcd')).toBe('ui://bffless/workflow/step-view.0123abcd.html')
    expect(STEP_VIEW_URI_PATTERN.test(stepViewUri('0123abcd'))).toBe(true)
    expect(STEP_VIEW_URI_PATTERN.test('ui://bffless/workflow/step-view.html')).toBe(false)
  })
})
