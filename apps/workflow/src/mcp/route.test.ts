// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RESOURCES_PATH, STEP_VIEW_RESOURCE_PATH, TOOLS_PATH, confinedSignPath, handler, kindOfPath, siblingBaseOf, type FnRequest } from './route'

const HEADERS = { 'x-forwarded-host': 'h.example', host: 'localhost:3000' }
const DEPLOYMENT = { owner: 'o', repo: 'r', commitSha: 'c', alias: 'workflow' }

/** A tool rule's request: its own path names the tool, the body is the arguments (what CE's mcp_handler sends a sibling). */
const call = (name: string, args: Record<string, unknown> = {}, headers: FnRequest['headers'] = HEADERS): FnRequest => ({
  body: args,
  headers,
  method: 'POST',
  path: `${TOOLS_PATH}${name.replace(/^workflow[./]/, '')}`,
})
const route = (request: FnRequest) => handler({ request, deployment: DEPLOYMENT })

describe('route', () => {
  it('reads the tool from the rule path, slash- and dot-tolerant', () => {
    expect(kindOfPath('/api/workflow/mcp-tools/submitStep')).toEqual({ kind: 'toolsCall', tool: 'workflow.submitStep' })
    expect(kindOfPath('/public/o/r/alias/workflow/dist/api/workflow/mcp-tools/status?x=1')).toEqual({ kind: 'toolsCall', tool: 'workflow.status' })
    expect(kindOfPath(RESOURCES_PATH)).toEqual({ kind: 'resourcesList', tool: '' })
    expect(kindOfPath(`/public/o/r/alias/workflow/dist${STEP_VIEW_RESOURCE_PATH}`)).toEqual({ kind: 'stepView', tool: '' })
    expect(kindOfPath('/api/workflow/mcp').kind).toBe('invalid')
    expect(kindOfPath('/api/workflow/mcp-tools/../run').kind).toBe('invalid')
    expect(kindOfPath('/api/workflow/runs').kind).toBe('invalid')
    const bad = route({ body: {}, headers: HEADERS, method: 'POST', path: '/api/workflow/nope' })
    expect(bad.kind).toBe('invalid')
    expect(bad.message).toContain('/api/workflow/nope')
  })

  it('derives the instance from the request, never from a constant', () => {
    const r = route(call('workflow.list'))
    expect(r.appOrigin).toBe('https://h.example')
    expect(r.aliasesUrl).toBe('http://localhost:3000/api/aliases?repository=o%2Fr')
    expect(r.stepViewUrl).toBe('https://h.example/step.html')
    const bare = route(call('workflow.list', {}, { host: 'only.example' }))
    expect(bare.appOrigin).toBe('https://only.example')
    const none = route(call('workflow.list', {}, {}))
    expect(none.appOrigin).toBe('')
    expect(none.stepViewUrl).toBe('')
  })

  it('sends sibling calls to CE in-process at the request’s own base path, and to the public origin without one', () => {
    const rewritten: FnRequest = { body: { impl: 'hello', workflow: 'interactive' }, headers: HEADERS, method: 'POST', path: '/public/o/r/alias/workflow/dist/api/workflow/mcp-tools/describe' }
    const r = route(rewritten)
    expect(r.tool).toBe('workflow.describe')
    expect(r.appOrigin).toBe('https://h.example')
    expect(r.siblingBase).toBe('http://localhost:3000/public/o/r/alias/workflow/dist')
    expect(r.stepViewUrl).toBe('http://localhost:3000/public/o/r/alias/workflow/dist/step.html')
    expect(r.indexUrl).toBe('http://localhost:3000/public/o/r/alias/workflow/dist/w/hello/.bffless/workflows/index.json')
    expect(r.indexPath).toBe('/w/hello/.bffless/workflows/index.json')
    expect(route(call('workflow.list')).siblingBase).toBe('https://h.example')
    expect(siblingBaseOf('/other/api/workflow/mcp-tools/list', 'https://h.example')).toBe('https://h.example')
  })

  it('gates the run rows on runId', () => {
    const status = route(call('workflow/status', { runId: 'run_1' }))
    expect(status.kind).toBe('toolsCall')
    expect(status.tool).toBe('workflow.status')
    expect(status.needsRun).toBe(true)
    expect(status.runId).toBe('run_1')
    expect(route(call('workflow.status')).needsRun).toBe(false)
    expect(route(call('workflow.outputs', { runId: 'r' })).needsRun).toBe(true)
    expect(route(call('workflow.submitStep', { runId: 'r', step: 'pick/0/choose' })).key).toBe('pick/0/choose')
    expect(route(call('workflow.list', { runId: 'r' })).needsRun).toBe(false)
    expect(route({ ...call('workflow.status'), body: 'not an object' }).args).toEqual({})
  })

  it('gates runs on impl + workflow', () => {
    const runs = route(call('workflow.runs', { impl: 'hello', workflow: 'interactive' }))
    expect(runs.isRuns).toBe(true)
    expect(runs.impl).toBe('hello')
    expect(route(call('workflow.runs', { impl: 'hello' })).isRuns).toBe(false)
  })

  it('names the discovery URLs, for the list tool and for the resources-list rule', () => {
    const list = route(call('workflow.list'))
    expect(list.isList).toBe(true)
    expect(list.isAliases).toBe(true)
    expect(list.indexUrl).toBe('')
    const one = route(call('workflow.list', { impl: 'hello' }))
    expect(one.isAliases).toBe(false)
    expect(one.indexUrl).toBe('https://h.example/w/hello/.bffless/workflows/index.json')
    const describe = route(call('workflow.describe', { impl: 'hello', workflow: 'interactive' }))
    expect(describe.isDescribe).toBe(true)
    expect(describe.indexUrl).toBe('https://h.example/w/hello/.bffless/workflows/index.json')
    expect(route(call('workflow.describe', { impl: 'hello' })).isDescribe).toBe(false)
    const resources = route({ body: undefined, headers: HEADERS, method: 'GET', path: RESOURCES_PATH })
    expect(resources.kind).toBe('resourcesList')
    expect(resources.isList).toBe(true)
    expect(resources.isAliases).toBe(true)
    expect(resources.needsRun).toBe(false)
  })

  it('confines a sign path exactly as files/sign does', () => {
    const ok = route(call('workflow.sign', { runId: 'r', path: 'workflows/a/b.svg' }))
    expect(ok.isSign).toBe(true)
    expect(ok.signStoragePath).toBe('o/r/uploads/workflows/a/b.svg')
    expect(confinedSignPath('/api/uploads/workflows/a/b.svg?x=1')).toBe('workflows/a/b.svg')
    for (const bad of ['../x', 'workflows/../x', 'workflows//x', 'other/x', '', 42]) {
      expect(confinedSignPath(bad), String(bad)).toBe('')
    }
    const refused = route(call('workflow.sign', { path: '../x' }))
    expect(refused.isSign).toBe(false)
    expect(refused.signStoragePath).toBe('')
  })

  it('flags the step-view resource rule', () => {
    const view = route({ body: undefined, headers: HEADERS, method: 'GET', path: `/public/o/r/alias/workflow/dist${STEP_VIEW_RESOURCE_PATH}` })
    expect(view.kind).toBe('stepView')
    expect(view.isStepView).toBe(true)
    expect(view.stepViewUrl).toBe('http://localhost:3000/public/o/r/alias/workflow/dist/step.html')
    expect(route({ body: undefined, headers: {}, method: 'GET', path: STEP_VIEW_RESOURCE_PATH }).isStepView).toBe(false)
  })

  it('leaves the aliases URL empty without a serving project', () => {
    const r = handler({ request: call('workflow.list') })
    expect(r.aliasesUrl).toBe('')
    expect(r.isAliases).toBe(false)
    const bare = route(call('workflow.describe', { impl: 'hello', workflow: 'x' }, {}))
    expect(bare.isDescribe).toBe(false)
  })
})
