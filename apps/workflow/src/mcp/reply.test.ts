// @vitest-environment node
import { CATALOG } from '@bffless/workflow-agent-tools'
import { describe, expect, it } from 'vitest'
import { HELLO_INDEX, INTERACTIVE_YAML, RUN_ID, runRow, stepRows } from './fixtures/index'
import { STEP_VIEW_URI, listedTools } from './hostTools'
import { handler as mergeOf } from './merge'
import { handler as planOf } from './plan'
import { REFUSALS } from './refusals'
import { handler as reply, type StepOutputs } from './reply'
import { handler as routeOf, type FnRequest } from './route'

const DEPLOYMENT = { owner: 'o', repo: 'r', commitSha: 'c', alias: 'workflow' }
const HEADERS = { host: 'h.example' }
const request = (body: unknown): FnRequest => ({ body, headers: HEADERS, method: 'POST', path: '/api/workflow/mcp' })
const NO_ID = Symbol('notification')
const message = (method: string, params: Record<string, unknown> = {}, id: number | string | typeof NO_ID = 1) =>
  request({ jsonrpc: '2.0', ...(id === NO_ID ? {} : { id }), method, params })
const callOf = (name: string, args: Record<string, unknown> = {}) => message('tools/call', { name, arguments: args })

const http = (body: unknown, status = 200) => ({ ok: status < 400, status, body })

/** Run the three function steps the way the pipeline does — route, plan, reply — over the fetched/queried outputs given. */
function run(req: FnRequest, fetched: Omit<StepOutputs, 'route' | 'plan'> = {}, user?: { id: string; credential?: string; scopes?: string[] }) {
  const route = routeOf({ request: req, deployment: DEPLOYMENT, user })
  const steps: StepOutputs = { ...fetched, route }
  steps.plan = planOf({ steps: { route, aliases: steps.aliases, index: steps.index, run: steps.run, steps: steps.steps }, deployment: DEPLOYMENT })
  if (!fetched.merge) steps.merge = mergeOf({ steps: { route, run: steps.run, steps: steps.steps } })
  const out = reply({ request: req, steps, deployment: DEPLOYMENT })
  return { out, body: out.json === '' ? null : (JSON.parse(out.json) as { id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } }) }
}
const result = (req: FnRequest, fetched?: Omit<StepOutputs, 'route' | 'plan'>) => {
  const { body } = run(req, fetched)
  return body!.result as { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
}
const text = (r: { content: { text: string }[] }) => r.content[0].text

describe('protocol', () => {
  it('answers initialize with a negotiated version and the server identity', () => {
    const { body } = run(message('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'x', version: '0' } }))
    expect(body!.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'bffless-workflow' } })
  })

  it('answers a notification with 202 and an empty body', () => {
    const { out } = run(message('notifications/initialized', {}, NO_ID))
    expect(out).toEqual({ json: '', status: 202 })
  })

  it('refuses a tool an app token has no scope for, as a tool error naming the scope (D23), and admits the scoped call', () => {
    const { body } = run(callOf('workflow.submitStep', { runId: RUN_ID, step: 'pick/0/choose', values: { line: 'x' } }), {}, { id: 'u', credential: 'app_token', scopes: ['workflow:read'] })
    const r = body!.result as { isError?: boolean; content: { text: string }[]; structuredContent?: { errors?: Record<string, string> } }
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('insufficient_scope: missing workflow:run')
    expect(r.structuredContent?.errors).toEqual({ scope: 'missing workflow:run' })
    const { body: ok } = run(callOf('workflow.status', { runId: RUN_ID }), { run: [runRow()], steps: stepRows() }, { id: 'u', credential: 'app_token', scopes: ['workflow:read'] })
    expect((ok!.result as { isError?: boolean }).isError).not.toBe(true)
  })

  it('lists the catalog byte for byte, plus the app-only tools', () => {
    const { body } = run(message('tools/list'))
    expect(body!.result).toEqual({ tools: listedTools() })
    const tools = (body!.result as { tools: Array<{ name: string }> }).tools
    expect(tools.slice(0, CATALOG.length).map((tool) => tool.name)).toEqual(CATALOG.map((tool) => tool.name))
  })

  it('answers ping, unknown methods and invalid messages per JSON-RPC', () => {
    expect(run(message('ping')).body!.result).toEqual({})
    expect(run(message('prompts/list')).body!.error).toMatchObject({ code: -32601 })
    const { body } = run(request([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))
    expect(body!.error).toMatchObject({ code: -32600 })
    expect(body!.id).toBeNull()
  })
})

describe('workflow.list', () => {
  const aliases = http({ data: [{ alias: 'workflow' }, { alias: 'hello' }, { alias: 'empty' }] })

  it('lists the implementations the fan-out found, worded as the page words them', () => {
    const r = result(callOf('workflow.list'), { aliases, index1: http(HELLO_INDEX), index2: http('not found', 404) })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe('hello — Hello v0.0.0: hello (headless-safe), interactive (headless-safe)')
    const impls = r.structuredContent!.implementations as Array<Record<string, unknown>>
    expect(impls).toHaveLength(1)
    expect(impls[0]).toMatchObject({ alias: 'hello', name: 'Hello', version: '0.0.0', preview: false })
    expect((impls[0].workflows as Array<Record<string, unknown>>)[1]).toEqual({
      id: 'interactive', file: 'interactive.workflow.yaml', name: 'Interactive hello', description: HELLO_INDEX.workflows[1].description, headlessSafe: true,
    })
    expect(impls[0]).not.toHaveProperty('islands')
  })

  it('refuses when the alias relay failed, with the page’s discovery refusal', () => {
    const r = result(callOf('workflow.list'), { aliases: http('unauthorised', 401) })
    expect(r.isError).toBe(true)
    expect(r.structuredContent!.errors).toEqual({ discovery: REFUSALS.discovery })
  })

  it('goes straight to one implementation when impl is given, and refuses an unknown one', () => {
    expect(text(result(callOf('workflow.list', { impl: 'hello' }), { index1: http(HELLO_INDEX) }))).toContain('hello — Hello')
    const r = result(callOf('workflow.list', { impl: 'nope' }), { index1: http('', 404) })
    expect(r.structuredContent!.errors).toEqual({ impl: 'No implementation "nope" is published here' })
  })

  it('reports what the prototype fan-out skipped', () => {
    const many = http({ data: ['workflow', 'a', 'b', 'c', 'd'].map((alias) => ({ alias })) })
    const r = result(callOf('workflow.list'), { aliases: many, index1: http(HELLO_INDEX), index2: http('', 404), index3: http('', 404) })
    expect(text(r)).toContain('(+1 more implementation not listed by the prototype endpoint)')
    expect(r.structuredContent!.skipped).toEqual(['d'])
  })
})

describe('workflow.describe', () => {
  it('describes from the published YAML exactly as the page describes from its loaded definition', () => {
    const r = result(callOf('workflow.describe', { impl: 'hello', workflow: 'interactive' }), { index: http(HELLO_INDEX), yaml: http(INTERACTIVE_YAML) })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe(
      'Interactive hello (hello/interactive): 2 inputs — greeting (string, required, default "Hello"), names (choice[], default ["world","studio"]); 5 jobs; 5 outputs; interactive steps: pick/choose (island, headless: auto; outputs: line (string, required), index (number)), review/confirm (form, headless: skip; fields: cover (choice, required), notes (markdown), extra (file)); headless-safe',
    )
    const jobs = r.structuredContent!.jobs as Array<{ id: string }>
    expect(jobs.map((job) => job.id)).toEqual(['greet', 'analyze', 'pick', 'card', 'review'])
    expect(r.structuredContent!.inputs).toMatchObject({ greeting: { type: 'string', required: true, default: 'Hello' } })
  })

  it("refuses with spec 07's strings when the index, the workflow or the file is missing", () => {
    expect(result(callOf('workflow.describe', { impl: 'hello', workflow: 'interactive' }), { index: http('', 404) }).structuredContent!.errors).toEqual({ workflow: REFUSALS.noWorkflow })
    expect(result(callOf('workflow.describe', { impl: 'hello', workflow: 'nope' }), { index: http(HELLO_INDEX) }).structuredContent!.errors).toEqual({ workflow: REFUSALS.noWorkflow })
    expect(result(callOf('workflow.describe', { impl: 'hello', workflow: 'interactive' }), { index: http(HELLO_INDEX), yaml: http('', 404) }).structuredContent!.errors).toEqual({ workflow: REFUSALS.fileUnreadable })
    expect(result(callOf('workflow.describe', { impl: 'hello', workflow: 'interactive' }), { index: http(HELLO_INDEX), yaml: http('jobs: [') }).structuredContent!.errors).toEqual({ workflow: REFUSALS.doesNotLint })
    expect(result(callOf('workflow.describe', { impl: 'hello' })).structuredContent!.errors).toHaveProperty('workflow')
  })
})

describe('workflow.status / outputs', () => {
  it('derives the snapshot from the rows and says what the page says', () => {
    const r = result(callOf('workflow.status', { runId: RUN_ID }), { run: [runRow()], steps: stepRows() })
    expect(text(r)).toBe(
      `Run ${RUN_ID} is running, waiting on pick/0/choose (island; outputs: line (string, required), index (number))\nTo let the person complete pick/0/choose here, call workflow.submitStep { runId: "${RUN_ID}", step: "pick/0/choose", values: {} } — the step's island renders in this chat; do not invent its values.`,
    )
    expect(r.structuredContent).toMatchObject({
      runId: RUN_ID,
      status: 'running',
      currentSteps: ['pick/0/choose'],
      waitingOn: [{ key: 'pick/0/choose', kind: 'island', src: 'islands/pick-line.html', outputs: { line: { type: 'string', required: true }, index: { type: 'number' } } }],
    })
  })

  it('requires runId and refuses an unknown run', () => {
    expect(result(callOf('workflow.status')).structuredContent!.errors).toHaveProperty('runId')
    expect(text(result(callOf('workflow.status', { runId: 'nope' }), { run: [], steps: [] }))).toBe('No such run: nope')
  })

  it('answers outputs with the page’s sentence', () => {
    expect(text(result(callOf('workflow.outputs', { runId: RUN_ID }), { run: [runRow()], steps: stepRows() }))).toBe(`Run ${RUN_ID} is running and has no outputs yet`)
    const done = result(callOf('workflow.outputs', { runId: RUN_ID }), { run: [runRow({ status: 'succeeded', outputs: { line: 'x', poster: { path: 'p' } } })], steps: [] })
    expect(text(done)).toBe(`Run ${RUN_ID} (succeeded) outputs: line, poster`)
    expect(done.structuredContent).toEqual({ runId: RUN_ID, status: 'succeeded', outputs: { line: 'x', poster: { path: 'p' } } })
  })
})

describe('workflow.runs', () => {
  const runsRows = [
    runRow({ id: 'a', runId: 'run_a', startedAt: 1_000, status: 'succeeded', finishedAt: 2_000 }),
    runRow({ id: 'b', runId: 'run_b', startedAt: 3_000 }),
    runRow({ id: 'c', runId: 'run_c', startedAt: 2_000, status: 'failed', finishedAt: 2_500 }),
  ]
  const waiting = [{ runId: 'run_b', key: 'pick/0/choose', status: 'waiting' }]

  it('lists newest first with waitingOn joined, shaped as the page shapes rows', () => {
    const r = result(callOf('workflow.runs', { impl: 'hello', workflow: 'interactive' }), { runs: runsRows, waiting })
    const listed = r.structuredContent!.runs as Array<Record<string, unknown>>
    expect(listed.map((row) => row.runId)).toEqual(['run_b', 'run_c', 'run_a'])
    expect(listed[0]).toEqual({ runId: 'run_b', status: 'running', startedAt: 3_000, headless: false, startedBy: 'member@example.com', waitingOn: ['pick/0/choose'] })
    expect(text(r)).toBe(`3 runs of hello/interactive:\nrun_b running (1970-01-01T00:00:03.000Z) waiting on pick/0/choose\nrun_c failed (1970-01-01T00:00:02.000Z)\nrun_a succeeded (1970-01-01T00:00:01.000Z)`)
  })

  it('filters by status, caps by limit, and requires impl + workflow', () => {
    const r = result(callOf('workflow.runs', { impl: 'hello', workflow: 'interactive', status: 'failed', limit: 1 }), { runs: runsRows, waiting })
    expect((r.structuredContent!.runs as unknown[]).length).toBe(1)
    expect(text(result(callOf('workflow.runs', { impl: 'hello', workflow: 'interactive', status: 'cancelled' }), { runs: runsRows, waiting }))).toBe('No runs of hello/interactive with status cancelled')
    expect(result(callOf('workflow.runs', { impl: 'hello' })).structuredContent!.errors).toHaveProperty('workflow')
  })
})

describe('workflow.sign', () => {
  it('answers the presigned URL for a confined path and refuses the rest with the rule’s own message', () => {
    const r = result(callOf('workflow.sign', { path: 'workflows/hello/x.svg' }), { signed: { url: 'https://storage.googleapis.com/b/k?sig=1' } })
    expect(text(r)).toBe('Signed workflows/hello/x.svg for 3600 s')
    expect(r.structuredContent).toEqual({ path: 'workflows/hello/x.svg', url: 'https://storage.googleapis.com/b/k?sig=1', expiresIn: 3600 })
    expect(result(callOf('workflow.sign', { path: '../x' })).structuredContent!.errors).toEqual({ path: 'path must be an uploads-relative key under workflows/ with no traversal' })
    expect(result(callOf('workflow.sign', { path: 'workflows/x' }), {}).structuredContent!.errors).toHaveProperty('path')
  })
})

describe('tools this build does not serve', () => {
  it('answers an honest error result, never a protocol error', () => {
    for (const name of ['workflow.start', 'workflow.cancel', 'workflow.resume', 'workflow.await']) {
      const r = result(callOf(name, { runId: 'r' }))
      expect(r.isError, name).toBe(true)
      expect(r.structuredContent!.errors).toHaveProperty('tool')
    }
    expect(text(result(callOf('workflow.await', { runId: 'r', until: 'terminal' })))).toContain('poll workflow.status')
    expect(text(result(callOf('workflow.submit', { runId: 'r', step: 's', outputs: {} }), { run: [], steps: [] }))).toBe('No such run: r')
    expect(result(callOf('echo')).structuredContent!.errors).toEqual({ tool: 'No such tool' })
  })
})

describe('resources', () => {
  const aliases = http({ data: [{ alias: 'workflow' }, { alias: 'hello' }] })
  const probe = { url: 'https://storage.googleapis.com/j5s-dev/o/r/uploads/workflows/.mcp-csp-probe?X-Goog-Signature=x' }

  it('lists the step view and every discovered island with a derived CSP', () => {
    const { body } = run(message('resources/list'), { aliases, index1: http(HELLO_INDEX), probe })
    const resources = (body!.result as { resources: Array<Record<string, unknown>> }).resources
    expect(resources.map((r) => r.uri)).toEqual([STEP_VIEW_URI, 'ui://bffless/hello/islands/pick-line.html', 'ui://bffless/hello/islands/line-viewer.html'])
    for (const r of resources) {
      expect(r.mimeType).toBe('text/html;profile=mcp-app')
      expect(r._meta).toEqual({ ui: { csp: { connectDomains: ['https://h.example', 'https://storage.googleapis.com'], resourceDomains: ['https://storage.googleapis.com'] }, prefersBorder: true } })
    }
  })

  it('reads an island unchanged, and the step view', () => {
    const { body } = run(message('resources/read', { uri: 'ui://bffless/hello/islands/pick-line.html' }), { island: http('<!doctype html><script>pick</script>'), probe })
    expect(body!.result).toEqual({
      contents: [{ uri: 'ui://bffless/hello/islands/pick-line.html', mimeType: 'text/html;profile=mcp-app', text: '<!doctype html><script>pick</script>', _meta: { ui: { csp: { connectDomains: ['https://h.example', 'https://storage.googleapis.com'], resourceDomains: ['https://storage.googleapis.com'] }, prefersBorder: true } } }],
    })
    const view = run(message('resources/read', { uri: STEP_VIEW_URI }), { stepView: http('<!doctype html>view'), probe })
    expect((view.body!.result as { contents: Array<{ text: string }> }).contents[0].text).toBe('<!doctype html>view')
  })

  it('answers -32002 for a fenced-out, failed or foreign URI', () => {
    expect(run(message('resources/read', { uri: 'ui://bffless/hello/../x.html' }), { probe }).body!.error).toMatchObject({ code: -32002 })
    expect(run(message('resources/read', { uri: 'ui://bffless/hello/islands/x.html' }), { island: http('', 404), probe }).body!.error).toMatchObject({ code: -32002 })
    expect(run(message('resources/read', { uri: 'file:///etc/passwd' })).body!.error).toMatchObject({ code: -32002 })
  })
})

describe('workflow.stepView / workflow.pipeline / the write verdict', () => {
  const html = '<!doctype html><script>pick</script>'

  it('answers what the step view mounts: the island HTML, the persisted inputs, the declared outputs', () => {
    const r = result(callOf('workflow.stepView', { runId: RUN_ID, step: 'pick/0/choose' }), { run: [runRow()], steps: stepRows(), island: http(html) })
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toEqual({
      runId: RUN_ID, step: 'pick/0/choose', impl: 'hello', workflow: 'interactive', kind: 'island', status: 'waiting', src: 'islands/pick-line.html',
      arguments: { lines: ['Hello, world!', 'Hello, studio!'], words: [{ w: 'Hello' }] },
      outputs: { line: { type: 'string', required: true }, index: { type: 'number' } },
      html,
    })
    expect(result(callOf('workflow.stepView', { runId: RUN_ID, step: 'greet/0/say' }), { run: [runRow()], steps: stepRows(), island: http(html) }).structuredContent!.errors).toEqual({ step: 'greet/0/say is a pipeline step, not an island' })
    expect(result(callOf('workflow.stepView', { runId: RUN_ID, step: 'pick/0/choose' }), { run: [runRow()], steps: stepRows(), island: http('', 404) }).structuredContent!.errors).toEqual({ step: 'pick/0/choose: the island file could not be fetched (404)' })
  })

  it('relays a pipeline answer the way IslandHost reports one, and refuses outside the fence', () => {
    const ok = result(callOf('workflow.pipeline', { runId: RUN_ID, step: 'pick/0/choose', name: 'echo', arguments: { text: 'hi' } }), { run: [runRow()], steps: stepRows(), pipelinePost: http({ text: 'HI' }) })
    expect(ok).toEqual({ content: [{ type: 'text', text: '{"text":"HI"}' }], structuredContent: { text: 'HI' } })
    const failed = result(callOf('workflow.pipeline', { runId: RUN_ID, step: 'pick/0/choose', name: 'fail' }), { run: [runRow()], steps: stepRows(), pipelinePost: http({ code: 'ON_PURPOSE', message: 'as asked' }, 500) }) as { isError?: boolean; content: { text: string }[]; _meta?: unknown }
    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toBe('ON_PURPOSE: as asked')
    expect(failed._meta).toEqual({ bffless: { status: 500 } })
    const fenced = result(callOf('workflow.pipeline', { runId: RUN_ID, step: 'pick/0/choose', name: '../workflow/run' }), { run: [runRow()], steps: stepRows() })
    expect(fenced.isError).toBe(true)
    expect(text(fenced)).toContain('resolves outside /api/hello/')
  })

  it('answers the write verdict, and notices a write that did not land', () => {
    const submitted = result(callOf('workflow.submit', { runId: RUN_ID, step: 'pick/0/choose', outputs: { line: 'Hello, world!', index: 0 } }), { run: [runRow()], steps: stepRows(), update: { id: 'rec_s4' } })
    expect(text(submitted)).toBe(`Submitted pick/0/choose; Run ${RUN_ID} is running`)
    const lost = result(callOf('workflow.submit', { runId: RUN_ID, step: 'pick/0/choose', outputs: { line: 'Hello, world!', index: 0 } }), { run: [runRow()], steps: stepRows() })
    expect(lost.structuredContent!.errors).toEqual({ step: 'pick/0/choose: the step row could not be written' })
    const refused = result(callOf('workflow.submit', { runId: RUN_ID, step: 'pick/0/choose', outputs: {} }), { run: [runRow()], steps: stepRows() })
    expect(refused.structuredContent!.errors).toEqual({ line: 'This field is required' })
    expect(text(result(callOf('workflow.annotate', { runId: RUN_ID, step: 'pick/0/choose', summary: 's' }), { run: [runRow()], steps: stepRows(), update: { id: 'rec_s4' } }))).toBe('ok')
  })
})
