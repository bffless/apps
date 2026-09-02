// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { aliasNames, handler } from './plan'
import { handler as routeOf, type FnRequest } from './route'

const DEPLOYMENT = { owner: 'o', repo: 'r', commitSha: 'c', alias: 'workflow' }
const HEADERS = { host: 'h.example' }
const request = (body: unknown): FnRequest => ({ body, headers: HEADERS, method: 'POST', path: '/api/workflow/mcp' })
const call = (name: string, args: Record<string, unknown> = {}) =>
  routeOf({ request: request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), deployment: DEPLOYMENT })
const read = (uri: string) =>
  routeOf({ request: request({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }), deployment: DEPLOYMENT })

const aliases = (...names: string[]) => ({ ok: true, status: 200, body: { data: names.map((alias) => ({ alias })) } })

describe('plan: list fan-out', () => {
  it('fetches up to three implementation indexes, skipping the harness alias and reporting the rest', () => {
    const plan = handler({ steps: { route: call('workflow.list'), aliases: aliases('workflow', 'hello', 'a', 'b', 'c') }, deployment: DEPLOYMENT })
    expect(plan.aliases).toEqual(['hello', 'a', 'b'])
    expect(plan.skipped).toEqual(['c'])
    expect([plan.has1, plan.has2, plan.has3]).toEqual([true, true, true])
    expect(plan.url1).toBe('https://h.example/w/hello/.bffless/workflows/index.json')
    expect(plan.url3).toBe('https://h.example/w/b/.bffless/workflows/index.json')
  })

  it('fetches exactly one index when impl is given', () => {
    const plan = handler({ steps: { route: call('workflow.list', { impl: 'hello' }), aliases: aliases('workflow', 'hello', 'a') }, deployment: DEPLOYMENT })
    expect(plan.aliases).toEqual(['hello'])
    expect([plan.has1, plan.has2, plan.has3]).toEqual([true, false, false])
    expect(plan.skipped).toEqual([])
  })

  it('plans nothing when the alias relay failed', () => {
    const plan = handler({ steps: { route: call('workflow.list'), aliases: { ok: false, status: 401, body: 'unauthorised' } }, deployment: DEPLOYMENT })
    expect(plan.aliases).toEqual([])
    expect(plan.has1).toBe(false)
  })

  it('reads either alias envelope', () => {
    expect(aliasNames({ data: [{ alias: 'a' }, { nope: 1 }] })).toEqual(['a'])
    expect(aliasNames([{ alias: 'b' }])).toEqual(['b'])
    expect(aliasNames('x')).toEqual([])
  })
})

describe('plan: describe', () => {
  const index = { ok: true, status: 200, body: { impl: 'hello', workflows: [{ file: 'hello.workflow.yaml', name: 'Hello' }, { file: 'interactive.workflow.yaml', name: 'Interactive hello', headlessSafe: true }] } }

  it("names the YAML by the index's file, not by a guess", () => {
    const plan = handler({ steps: { route: call('workflow.describe', { impl: 'hello', workflow: 'interactive' }), index }, deployment: DEPLOYMENT })
    expect(plan.hasYaml).toBe(true)
    expect(plan.yamlUrl).toBe('https://h.example/w/hello/.bffless/workflows/interactive.workflow.yaml')
    expect(plan.listing).toMatchObject({ name: 'Interactive hello', headlessSafe: true })
  })

  it('has no YAML for a workflow the index does not list, or a failed index', () => {
    expect(handler({ steps: { route: call('workflow.describe', { impl: 'hello', workflow: 'nope' }), index }, deployment: DEPLOYMENT }).hasYaml).toBe(false)
    expect(handler({ steps: { route: call('workflow.describe', { impl: 'hello', workflow: 'interactive' }), index: { ok: false, status: 404, body: '' } }, deployment: DEPLOYMENT }).hasYaml).toBe(false)
  })
})

describe('plan: island resources', () => {
  it('fetches /w/<impl>/<rest> through the same fence the page applies', () => {
    const plan = handler({ steps: { route: read('ui://bffless/hello/islands/pick-line.html') }, deployment: DEPLOYMENT })
    expect(plan.hasIsland).toBe(true)
    expect(plan.islandUrl).toBe('https://h.example/w/hello/islands/pick-line.html')
  })

  it('refuses a traversal with the fence’s own message', () => {
    const plan = handler({ steps: { route: read('ui://bffless/hello/../other/x.html') }, deployment: DEPLOYMENT })
    expect(plan.hasIsland).toBe(false)
    expect(plan.islandError).toContain('must resolve inside /w/hello/')
  })
})
