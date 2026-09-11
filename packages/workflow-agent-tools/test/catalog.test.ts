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

  /**
   * `scope` on `workflow.runs` (spec 11 §Listing: two queries, D26/D27). A
   * published contract gains an argument: a host that cached the old tool list
   * simply never passes it and lands on the default, "mine" — which is the
   * right failure. `required` stays empty and the schema stays closed.
   */
  it('takes an asked-for scope on workflow.runs, mine by default (spec 11, D27)', () => {
    const runs = toolByName('workflow.runs')!
    const scope = runs.inputSchema.properties.scope as { type?: string; enum?: string[]; description?: string } | undefined
    expect(scope).toBeDefined()
    expect(scope!.type).toBe('string')
    expect(scope!.enum).toEqual(['mine', 'all'])
    expect(scope!.description).toBe(
      'mine (default): runs you started. all: every run of the workflow — project owner/admin only, and only when asked (D27); refused with errors.scope otherwise.',
    )
    expect(runs.inputSchema.required).toEqual([])
    expect(runs.inputSchema.additionalProperties).toBe(false)
    expect(runs.description).toContain('Lists your own runs unless scope is all.')
  })

  /**
   * `scope` on the tools that name **one** run (spec 11, D27; apps#673, which
   * reverses the read half of the ownership plan's Decision 6). The gate always
   * read `scope` out of the tool arguments — the schemas were closed, so the
   * host rejected the argument before the gate saw it. Widening is additive:
   * a host with a cached tool list never passes it and lands on `mine`.
   *
   * The writes keep the schema they had. Acting on someone else's run is what
   * sharing/grants is for, not `scope`.
   */
  it('takes an asked-for scope on the run-scoped reads, and on no write (spec 11, D27)', () => {
    const description =
      'mine (default): only a run you started. all: any run of the project — project owner/admin only, and only when asked (D27). A run you may not read answers No such run, never a scope error.'
    for (const name of ['workflow.status', 'workflow.outputs', 'workflow.await', 'workflow.sign']) {
      const scope = toolByName(name)!.inputSchema.properties.scope as { type?: string; enum?: string[]; description?: string } | undefined
      expect(scope, name).toBeDefined()
      expect(scope!.type, name).toBe('string')
      expect(scope!.enum, name).toEqual(['mine', 'all'])
      expect(scope!.description, name).toBe(description)
    }
    for (const name of ['workflow.submitStep', 'workflow.cancel', 'workflow.resume']) {
      expect(toolByName(name)!.inputSchema.properties.scope, name).toBeUndefined()
    }
  })

  /**
   * `workflow.cancel` shared `workflow.status`' schema object outright, so
   * widening the reads in place would have widened a write with them (apps#673).
   */
  it('gives cancel a schema object of its own, unwidened', () => {
    expect(toolByName('workflow.cancel')!.inputSchema).not.toBe(toolByName('workflow.status')!.inputSchema)
    expect(Object.keys(toolByName('workflow.cancel')!.inputSchema.properties)).toEqual(['runId'])
  })
})
