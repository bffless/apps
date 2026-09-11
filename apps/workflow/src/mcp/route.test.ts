// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { FnUser } from './runGate'
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

  /**
   * `workflow.runs` is FILTERED, not gated (spec 11): one of two queries runs,
   * and which one is the caller's own ask plus their project role (D27) — the
   * MCP twin of `runs/get`'s `scope.fn.js`, reading the ask off the tool
   * arguments rather than the query string.
   */
  describe('the scope a workflow.runs call asked for (D27)', () => {
    const LIST = { impl: 'hello', workflow: 'interactive' }
    const scoped = (args: Record<string, unknown>, user?: FnUser) => handler({ request: call('workflow.runs', args), deployment: DEPLOYMENT, user })
    const OWNER: FnUser = { id: 'u', projectRole: 'owner' }
    const MEMBER: FnUser = { id: 'u', projectRole: 'contributor' }
    const flags = (r: { isMine: boolean; isAll: boolean; scopeForbidden: boolean }) => [r.isMine, r.isAll, r.scopeForbidden]

    it('defaults to the caller’s own runs, for every role', () => {
      expect(flags(scoped(LIST, MEMBER))).toEqual([true, false, false])
      expect(flags(scoped(LIST, OWNER))).toEqual([true, false, false])
      expect(flags(scoped({ ...LIST, scope: 'mine' }, OWNER))).toEqual([true, false, false])
    })

    it('widens only for an owner or admin who asked', () => {
      expect(flags(scoped({ ...LIST, scope: 'all' }, OWNER))).toEqual([false, true, false])
      expect(flags(scoped({ ...LIST, scope: 'all' }, { id: 'u', projectRole: 'ADMIN' }))).toEqual([false, true, false])
    })

    it('refuses an asked-for scope=all the caller has no role for — the one 403 in the model', () => {
      expect(flags(scoped({ ...LIST, scope: 'all' }, MEMBER))).toEqual([false, false, true])
      expect(flags(scoped({ ...LIST, scope: 'all' }))).toEqual([false, false, true])
      expect(flags(scoped({ ...LIST, scope: 'all' }, { id: 'u' }))).toEqual([false, false, true])
    })

    it('says nothing about scope for a call that is not a listing', () => {
      const none = scoped({ impl: 'hello', scope: 'all' }, MEMBER)
      expect(flags(none)).toEqual([false, false, false])
      const status = handler({ request: call('workflow.status', { runId: 'run_1', scope: 'all' }), deployment: DEPLOYMENT, user: MEMBER })
      expect(flags(status)).toEqual([false, false, false])
    })
  })

  /**
   * `workflow.sign` is run-scoped through the path it signs, not through an
   * argument (spec 11 D29): a `runs/<runId>/` key belongs to that run, and
   * every other confined key (`inputs/…`) is member-wide, which is `runless`.
   * Mirrors `files/sign/post/confine.fn.js`, case-insensitive `runs` included.
   */
  describe('the run a sign path names (D29)', () => {
    const RUN = 'run_01TEST'
    const signOf = (args: Record<string, unknown>) => route(call('workflow.sign', args))

    it('gates a run path on that run', () => {
      const r = signOf({ path: `workflows/hello/interactive/runs/${RUN}/pick/0/choose/poster.svg` })
      expect([r.isSign, r.needsRun, r.runless]).toEqual([true, true, false])
      expect(r.runId).toBe(RUN)
      expect(signOf({ path: `workflows/hello/interactive/RUNS/${RUN}/x.svg` }).runId).toBe(RUN)
      // The path decides, never the argument: a signable key is judged by the run it is under.
      expect(signOf({ runId: 'run_other', path: `workflows/hello/interactive/runs/${RUN}/x.svg` }).runId).toBe(RUN)
    })

    it('leaves a member-wide path runless, so the gate admits it with nothing to judge (D18)', () => {
      const r = signOf({ path: 'workflows/hello/interactive/inputs/a.png' })
      expect([r.isSign, r.needsRun, r.runless]).toEqual([true, false, true])
      expect(r.runId).toBe('')
      expect(signOf({ runId: RUN, path: 'workflows/hello/interactive/inputs/a.png' }).needsRun).toBe(false)
    })

    it('leaves an unsignable path neither — the gate refuses and nothing is signed', () => {
      for (const path of ['../x', 'other/x', 'workflows/hello/interactive/runs/not-a-run/x.svg']) {
        const r = signOf({ path })
        expect([r.needsRun, r.runless], path).toEqual([false, path.startsWith('workflows/')])
      }
      expect(route(call('workflow.status', { runId: 'run_1' })).runless).toBe(false)
    })
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
