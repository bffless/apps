// @vitest-environment node
import { CATALOG } from '@bffless/workflow-agent-tools'
import { describe, expect, it } from 'vitest'
import { HOST_TOOLS, RESOURCE_MIME, STEP_VIEW_URI, isHostTool, listedTools } from './hostTools'

describe('listedTools', () => {
  const listed = listedTools()

  it('is the catalog followed by the four app-only tools', () => {
    expect(listed.length).toBe(CATALOG.length + 4)
    expect(listed.slice(CATALOG.length).map((tool) => tool.name)).toEqual(HOST_TOOLS.map((tool) => tool.name))
  })

  it("carries the catalog's descriptors byte for byte, without the scope", () => {
    for (let i = 0; i < CATALOG.length; i++) {
      const { name, description, inputSchema, annotations } = CATALOG[i]
      const { _meta, ...wire } = listed[i]
      void _meta
      expect(JSON.stringify(wire)).toBe(JSON.stringify({ name, description, inputSchema, annotations }))
      expect(listed[i]).not.toHaveProperty('scope')
    }
  })

  it('links the step view from workflow.submitStep only', () => {
    const withUi = listed.filter((tool) => (tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri)
    expect(withUi.map((tool) => tool.name)).toEqual(['workflow.submitStep'])
    expect((withUi[0]._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(STEP_VIEW_URI)
  })

  it('marks every host tool app-only and run/step scoped', () => {
    for (const tool of HOST_TOOLS) {
      expect(tool._meta.ui.visibility).toEqual(['app'])
      expect(tool.inputSchema.required.slice(0, 2)).toEqual(['runId', 'step'])
      expect(isHostTool(tool.name)).toBe(true)
    }
    expect(isHostTool('workflow.sign')).toBe(false)
  })

  it('names the MCP Apps MIME type', () => {
    expect(RESOURCE_MIME).toBe('text/html;profile=mcp-app')
  })
})
