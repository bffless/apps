// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { STEP_VIEW_URI } from './hostTools'
import { confinedSignPath, handler, parseIslandUri, siblingBaseOf, type FnRequest } from './route'

const HEADERS = { 'x-forwarded-host': 'h.example', host: 'localhost:3000' }
const DEPLOYMENT = { owner: 'o', repo: 'r', commitSha: 'c', alias: 'workflow' }

function req(body: unknown, headers: FnRequest['headers'] = HEADERS): FnRequest {
  return { body, headers, method: 'POST', path: '/api/workflow/mcp' }
}
const call = (name: string, args: Record<string, unknown> = {}, id: number | string = 1) =>
  req({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const route = (request: FnRequest) => handler({ request, deployment: DEPLOYMENT })
const asToken = (scopes: string[]) => ({ id: 'u', credential: 'app_token', scopes })

describe('route', () => {
  it('derives the instance from the request, never from a constant', () => {
    const r = route(req({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    expect(r.kind).toBe('ping')
    expect(r.appOrigin).toBe('https://h.example')
    expect(r.aliasesUrl).toBe('http://localhost:3000/api/aliases?repository=o%2Fr')
    expect(r.stepViewUrl).toBe('https://h.example/step.html')
    expect(r.probePath).toBe('o/r/uploads/workflows/.mcp-csp-probe')
    const bare = route(req({ jsonrpc: '2.0', id: 1, method: 'ping' }, { host: 'only.example' }))
    expect(bare.appOrigin).toBe('https://only.example')
    const none = route(req({ jsonrpc: '2.0', id: 1, method: 'ping' }, {}))
    expect(none.appOrigin).toBe('')
  })

  it('sends sibling calls to CE in-process at the request’s own base path, and to the public origin without one', () => {
    const rewritten: FnRequest = { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workflow.describe', arguments: { impl: 'hello', workflow: 'interactive' } } }, headers: HEADERS, method: 'POST', path: '/public/o/r/alias/workflow/dist/api/workflow/mcp' }
    const r = route(rewritten)
    expect(r.appOrigin).toBe('https://h.example')
    expect(r.siblingBase).toBe('http://localhost:3000/public/o/r/alias/workflow/dist')
    expect(r.stepViewUrl).toBe('http://localhost:3000/public/o/r/alias/workflow/dist/step.html')
    expect(r.indexUrl).toBe('http://localhost:3000/public/o/r/alias/workflow/dist/w/hello/.bffless/workflows/index.json')
    expect(route(call('workflow.list')).siblingBase).toBe('https://h.example')
    expect(siblingBaseOf('/api/workflow/mcp', 'https://h.example')).toBe('https://h.example')
    expect(siblingBaseOf('/other/api/workflow/mcp', 'https://h.example')).toBe('https://h.example')
  })

  it('classifies the protocol methods', () => {
    expect(route(req({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).kind).toBe('initialize')
    expect(route(req({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).kind).toBe('toolsList')
    expect(route(req({ jsonrpc: '2.0', id: 1, method: 'prompts/list' })).kind).toBe('unknown')
    const list = route(req({ jsonrpc: '2.0', id: 1, method: 'resources/list' }))
    expect(list.kind).toBe('resourcesList')
    expect(list.isList).toBe(true)
    expect(list.isAliases).toBe(true)
    expect(list.isCsp).toBe(true)
    const batch = route(req([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))
    expect(batch.kind).toBe('invalid')
    const notification = route(req({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    expect(notification.kind).toBe('notification')
    expect(notification.isNotification).toBe(true)
    expect(notification.isRequest).toBe(false)
    expect(batch.isRequest).toBe(true)
    for (const flag of ['needsRun', 'isRuns', 'isList', 'isAliases', 'isDescribe', 'isIslandUri', 'isStepView', 'isCsp', 'isSign'] as const) {
      expect(notification[flag], flag).toBe(false)
    }
  })

  it('reads a tools/call, slash-tolerant, and gates the run rows on runId', () => {
    const status = route(call('workflow/status', { runId: 'run_1' }))
    expect(status.kind).toBe('toolsCall')
    expect(status.tool).toBe('workflow.status')
    expect(status.needsRun).toBe(true)
    expect(status.runId).toBe('run_1')
    expect(route(call('workflow.status')).needsRun).toBe(false)
    expect(route(call('workflow.outputs', { runId: 'r' })).needsRun).toBe(true)
    expect(route(call('workflow.submitStep', { runId: 'r', step: 'pick/0/choose' })).key).toBe('pick/0/choose')
    expect(route(call('workflow.list', { runId: 'r' })).needsRun).toBe(false)
  })

  it('gates runs on impl + workflow', () => {
    const runs = route(call('workflow.runs', { impl: 'hello', workflow: 'interactive' }))
    expect(runs.isRuns).toBe(true)
    expect(runs.impl).toBe('hello')
    expect(route(call('workflow.runs', { impl: 'hello' })).isRuns).toBe(false)
  })

  it('names the discovery URLs', () => {
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

  it('reads resources/read for the step view and for islands', () => {
    const view = route(req({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: STEP_VIEW_URI } }))
    expect(view.kind).toBe('resourcesRead')
    expect(view.isStepView).toBe(true)
    expect(view.isIslandUri).toBe(false)
    expect(view.isCsp).toBe(true)
    const island = route(req({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://bffless/hello/islands/pick-line.html' } }))
    expect(island.isIslandUri).toBe(true)
    expect(island.impl).toBe('hello')
    expect(island.rest).toBe('islands/pick-line.html')
    expect(island.isCsp).toBe(true)
    const other = route(req({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'file:///etc/passwd' } }))
    expect(other.isIslandUri).toBe(false)
    expect(other.isStepView).toBe(false)
  })

  it('parses ui:// URIs strictly', () => {
    expect(parseIslandUri('ui://bffless/hello/islands/x.html')).toEqual({ impl: 'hello', rest: 'islands/x.html' })
    expect(parseIslandUri('ui://bffless/hello')).toBeNull()
    expect(parseIslandUri('ui://bffless/hello/')).toBeNull()
    expect(parseIslandUri('ui://bffless/Bad Alias/x')).toBeNull()
    expect(parseIslandUri(STEP_VIEW_URI)).toBeNull()
    expect(parseIslandUri('ui://other/hello/x')).toBeNull()
  })

  it('leaves the aliases URL empty without a serving project', () => {
    const r = handler({ request: call('workflow.list') })
    expect(r.aliasesUrl).toBe('')
    expect(r.isAliases).toBe(false)
    expect(r.probePath).toBe('')
    const bare = route(req({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workflow.describe', arguments: { impl: 'hello', workflow: 'x' } } }, {}))
    expect(bare.isDescribe).toBe(false)
  })

  it('refuses a tool whose scope an app token lacks before any step runs, and never scope-checks a session (D23)', () => {
    const submit = handler({ request: call('workflow.submitStep', { runId: 'run_1', step: 'k', values: { a: 1 } }), deployment: DEPLOYMENT, user: asToken(['workflow:read']) })
    expect(submit.scopeMissing).toBe('workflow:run')
    expect(submit.needsRun).toBe(false)
    expect(submit.kind).toBe('toolsCall')
    const status = handler({ request: call('workflow.status', { runId: 'run_1' }), deployment: DEPLOYMENT, user: asToken(['workflow:read']) })
    expect(status.scopeMissing).toBe('')
    expect(status.needsRun).toBe(true)
    const list = handler({ request: call('workflow.list'), deployment: DEPLOYMENT, user: asToken([]) })
    expect(list.scopeMissing).toBe('workflow:read')
    expect(list.isList).toBe(false)
    // the four app-only tools have their own map
    const pipeline = handler({ request: call('workflow.pipeline', { runId: 'run_1', step: 'k', name: 'echo' }), deployment: DEPLOYMENT, user: asToken(['workflow:read']) })
    expect(pipeline.scopeMissing).toBe('workflow:run')
    const view = handler({ request: call('workflow.stepView', { runId: 'run_1', step: 'k' }), deployment: DEPLOYMENT, user: asToken(['workflow:read']) })
    expect(view.scopeMissing).toBe('')
    // a session is never a delegation; a stranger tool has no scope to miss
    const session = handler({ request: call('workflow.submitStep', { runId: 'run_1', step: 'k', values: {} }), deployment: DEPLOYMENT, user: { id: 'u', credential: 'session' } })
    expect(session.scopeMissing).toBe('')
    expect(session.needsRun).toBe(true)
    const stranger = handler({ request: call('video.slice'), deployment: DEPLOYMENT, user: asToken([]) })
    expect(stranger.scopeMissing).toBe('')
  })
})
