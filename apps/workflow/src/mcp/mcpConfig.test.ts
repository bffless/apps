// @vitest-environment node
import { CATALOG, SCOPES, TOOL_SCOPES } from '@bffless/workflow-agent-tools'
import { describe, expect, it } from 'vitest'
import { HOST_TOOLS, stepViewUri } from './hostTools'
import { ALL_TOOLS, TOOL_STEPS, mcpHandlerConfig, shortName, toolRulePath, toolScope } from './mcpConfig'

const REV = '0123abcd'

describe('the rendered mcp_handler config (D19 by construction)', () => {
  const config = mcpHandlerConfig({ rev: REV }) as { tools: Array<Record<string, unknown>>; resources: Record<string, unknown>; serverInfo: { name: string } }

  it('lists the catalog byte for byte, then the four app-only tools', () => {
    expect(config.tools).toHaveLength(CATALOG.length + HOST_TOOLS.length)
    config.tools.slice(0, CATALOG.length).forEach((tool, i) => {
      const { name, description, inputSchema, annotations } = CATALOG[i]
      expect({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }).toEqual({ name, description, inputSchema, annotations })
      expect(tool).not.toHaveProperty('scope')
      expect(tool).not.toHaveProperty('visibility')
    })
    for (const tool of config.tools.slice(CATALOG.length)) expect(tool.visibility).toEqual(['app'])
    expect(config.tools.find((t) => t.name === 'workflow.submitStep')?._meta).toEqual({ ui: { resourceUri: stepViewUri(REV) } })
    expect(config.tools.filter((t) => t._meta)).toHaveLength(1)
  })

  it('maps every tool to its own sibling rule under mcp-tools/', () => {
    for (const tool of config.tools) {
      expect(tool.rule).toEqual({ path: `/api/workflow/mcp-tools/${shortName(tool.name as string)}`, method: 'POST' })
    }
    expect(toolRulePath('workflow.submitStep')).toBe('/api/workflow/mcp-tools/submitStep')
    expect(config.serverInfo.name).toBe('bffless-workflow')
  })

  it('declares the step view, the island template, the list rule and the CSP tokens', () => {
    expect(config.resources).toEqual({
      static: [{ uri: stepViewUri(REV), name: 'Workflow step view', description: 'Mounts a waiting island or form step of a run (spec 10).', rule: { path: '/api/workflow/mcp-resources/step-view' } }],
      templates: [{ uriTemplate: 'ui://bffless/{impl}/{path+}', name: 'island', description: 'An island of an implementation, served unchanged from its bundle (spec 04).', rule: { path: '/w/{impl}/{path+}' } }],
      list: { rule: { path: '/api/workflow/mcp-resources', method: 'GET' } },
      csp: { connectDomains: ['$app', '$storage'], resourceDomains: ['$storage'] },
    })
  })

  it('gives every tool a step list that starts with route and ends with reply, and a scope from the catalog', () => {
    for (const tool of ALL_TOOLS) {
      const steps = TOOL_STEPS[tool as keyof typeof TOOL_STEPS]
      expect(steps[0], tool).toBe('route')
      expect(steps[steps.length - 1], tool).toBe('reply')
      expect(SCOPES, tool).toContain(toolScope(tool))
    }
    for (const [name, scope] of Object.entries(TOOL_SCOPES)) expect(toolScope(name)).toBe(scope)
    expect(toolScope('workflow.submit')).toBe('workflow:run')
    expect(toolScope('workflow.stepView')).toBe('workflow:read')
    expect(() => toolScope('video.slice')).toThrow()
  })

  it('drives the three tools that dispatch: start after its index, resume after its rows, submitStep after its write (ADR-0006)', () => {
    expect(TOOL_STEPS['workflow.start']).toEqual(['route', 'index', 'plan', 'drive', 'reply'])
    expect(TOOL_STEPS['workflow.resume']).toEqual(['route', 'run', 'runGate', 'steps', 'plan', 'drive', 'reply'])
    // `plan` runs AFTER `update` here: whether to dispatch is whether the write landed.
    expect(TOOL_STEPS['workflow.submitStep']).toEqual(['route', 'run', 'runGate', 'steps', 'merge', 'update', 'plan', 'drive', 'reply'])
  })

  /**
   * Spec 11 §One gate, not twenty-five copies: the eleven run-scoped tools —
   * the seven catalog tools that take a `runId` and the four host tools — read
   * the run through the SHARED gate, never off their own query. The gate step
   * always follows the `run` query it judges, and every later step that reads
   * the run is conditioned on it (held by the rule fence, which reads the
   * rendered YAML).
   */
  it('sends the eleven run-scoped tools through the shared gate (spec 11, D26)', () => {
    const GATED = [
      'workflow.status', 'workflow.await', 'workflow.outputs', 'workflow.sign', 'workflow.cancel',
      'workflow.resume', 'workflow.submitStep', 'workflow.submit', 'workflow.annotate', 'workflow.pipeline', 'workflow.stepView',
    ]
    for (const tool of GATED) {
      const steps = TOOL_STEPS[tool as keyof typeof TOOL_STEPS]
      expect(steps.indexOf('runGate'), tool).toBeGreaterThan(-1)
      expect(steps.indexOf('run'), `${tool}: the gate judges the run query before it`).toBe(steps.indexOf('runGate') - 1)
    }
    expect(TOOL_STEPS['workflow.status']).toEqual(['route', 'run', 'runGate', 'steps', 'reply'])
    expect(TOOL_STEPS['workflow.await']).toEqual(['route', 'run', 'runGate', 'reply'])
    expect(TOOL_STEPS['workflow.cancel']).toEqual(['route', 'run', 'runGate', 'reply'])
    expect(TOOL_STEPS['workflow.sign']).toEqual(['route', 'run', 'runGate', 'signed', 'reply'])
    // Neither of the three names a run: two describe, one creates one.
    for (const tool of ['workflow.list', 'workflow.describe', 'workflow.start']) {
      expect(TOOL_STEPS[tool as keyof typeof TOOL_STEPS], tool).not.toContain('runGate')
    }
  })

  it('lists runs with two scoped queries, because a filter cannot be conditional (spec 11, D27)', () => {
    expect(TOOL_STEPS['workflow.runs']).toEqual(['route', 'runs', 'runsAll', 'waiting', 'reply'])
    expect(TOOL_STEPS['workflow.runs']).not.toContain('runGate')
  })
})
