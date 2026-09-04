import { CATALOG } from '@bffless/workflow-agent-tools'
import { describe, expect, it } from 'vitest'
import { STEP_VIEW_URI_PATTERN, canonical, cspOf, originOf, stepViewUriOf, toolParity, type ListedTool } from './mcp-checks.js'

const wire = (): ListedTool[] =>
  CATALOG.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }))

describe('toolParity', () => {
  it('is empty for the catalog as listed, whatever the key order', () => {
    const shuffled: ListedTool[] = wire().map((tool) => ({ annotations: tool.annotations, inputSchema: tool.inputSchema, description: tool.description, name: tool.name }))
    expect(toolParity(shuffled, CATALOG)).toEqual([])
    expect(toolParity([...wire(), { name: 'workflow.submit' }], CATALOG)).toEqual([])
  })

  it('names the first differing field', () => {
    const listed = wire()
    listed[2] = { ...listed[2], name: 'workflow.start', description: 'changed' }
    expect(toolParity(listed, CATALOG)).toEqual(['workflow.start.description differs'])
    expect(toolParity(listed.slice(0, 3), CATALOG)[0]).toMatch(/has 3 tools/)
    const renamed = wire()
    renamed[0] = { ...renamed[0], name: 'workflow.ls' }
    expect(toolParity(renamed, CATALOG)).toEqual(['tool 0: workflow.ls ≠ workflow.list'])
  })
})

describe('cspOf / originOf / canonical', () => {
  it('reads the csp arrays and origins', () => {
    expect(cspOf({ _meta: { ui: { csp: { connectDomains: ['https://a', 'https://b'], resourceDomains: ['https://b'] } } } })).toEqual({
      connectDomains: ['https://a', 'https://b'],
      resourceDomains: ['https://b'],
    })
    expect(cspOf({})).toBeNull()
    expect(originOf('https://storage.googleapis.com/x/y?z=1')).toBe('https://storage.googleapis.com')
    expect(originOf('nope')).toBe('')
    expect(canonical({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}')
  })
})

describe('stepViewUriOf', () => {
  it('reads the revisioned step-view URI off tools/list', () => {
    const listed = [{ name: 'workflow.submitStep', _meta: { ui: { resourceUri: 'ui://bffless/workflow/step-view.0123abcd.html' } } }, { name: 'workflow.status' }]
    expect(stepViewUriOf(listed)).toBe('ui://bffless/workflow/step-view.0123abcd.html')
    expect(STEP_VIEW_URI_PATTERN.test(stepViewUriOf(listed))).toBe(true)
    expect(stepViewUriOf([{ name: 'workflow.status' }])).toBe('')
  })
})
