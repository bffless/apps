import { describe, expect, it } from 'vitest'
import { CATALOG, TOOL_NAMES, canonicalToolName, toolByName } from '../src/catalog.js'
import { TOOL_SCOPES } from '../src/scopes.js'
import { CATALOG_VERSION } from '../src/index.js'

/** Spec 10's table: which arguments each tool cannot do without. */
const REQUIRED: Record<string, string[]> = {
  'workflow.list': [],
  'workflow.describe': ['impl', 'workflow'],
  'workflow.start': ['impl', 'workflow', 'inputs'],
  'workflow.status': [],
  'workflow.await': ['until'],
  'workflow.runs': [],
  'workflow.submitStep': ['step', 'values'],
  'workflow.outputs': [],
  'workflow.sign': ['path'],
  'workflow.cancel': [],
  'workflow.resume': ['runId'],
}

describe('the catalog', () => {
  it('is versioned', () => {
    expect(CATALOG_VERSION).toBe(1)
  })

  it('lists the eleven spec-10 tools, in order, once each', () => {
    expect(CATALOG.map((tool) => tool.name)).toEqual([...TOOL_NAMES])
    expect(new Set(TOOL_NAMES).size).toBe(11)
  })

  it('describes every tool for a model', () => {
    for (const tool of CATALOG) {
      expect(tool.description.length, tool.name).toBeGreaterThan(20)
      expect(tool.description.trim(), tool.name).toBe(tool.description)
    }
  })

  it('gives every tool a closed object schema with the spec-10 required keys', () => {
    for (const tool of CATALOG) {
      expect(tool.inputSchema.type, tool.name).toBe('object')
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false)
      expect(tool.inputSchema.required, tool.name).toEqual(REQUIRED[tool.name])
      for (const key of tool.inputSchema.required) {
        expect(Object.keys(tool.inputSchema.properties), `${tool.name} declares ${key}`).toContain(key)
      }
    }
  })

  it('marks exactly the read-scope tools readOnlyHint', () => {
    for (const tool of CATALOG) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(TOOL_SCOPES[tool.name] === 'workflow:read')
      expect(tool.scope, tool.name).toBe(TOOL_SCOPES[tool.name])
    }
    expect(CATALOG.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual([
      'workflow.list',
      'workflow.describe',
      'workflow.status',
      'workflow.await',
      'workflow.runs',
      'workflow.outputs',
    ])
  })

  it('names dot-canonical, slash-tolerant (04)', () => {
    expect(canonicalToolName('workflow/submitStep')).toBe('workflow.submitStep')
    expect(canonicalToolName('workflow.submitStep')).toBe('workflow.submitStep')
    expect(toolByName('workflow/list')?.name).toBe('workflow.list')
    expect(toolByName('workflow.sign')?.name).toBe('workflow.sign')
    expect(toolByName('echo')).toBeUndefined()
    expect(toolByName('')).toBeUndefined()
  })

  it('is frozen — adapters read it, never edit it', () => {
    expect(Object.isFrozen(CATALOG)).toBe(true)
    expect(Object.isFrozen(CATALOG[0])).toBe(true)
  })
})
