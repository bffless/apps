// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HELLO_INDEX, HELLO_INDEX_WITH_DRIVER, INTERACTIVE_YAML, REVIEW_INPUTS, RUN_ID, formStepRows, runRow, stepRows } from './fixtures/index'
import { RUN_ID_PATTERN, mintRunId } from './ids'
import { handler as mergeOf } from './merge'
import { handler as planOf } from './plan'
import { REFUSALS } from './refusals'
import { handler as reply, type StepOutputs } from './reply'
import { RESOURCES_PATH, TOOLS_PATH, handler as routeOf, type FnRequest } from './route'

const DEPLOYMENT = { owner: 'o', repo: 'r', commitSha: 'c', alias: 'workflow' }
const HEADERS = { host: 'h.example' }
/** A tool rule's request: the path names the tool, the body is the arguments (what CE's mcp_handler sends a sibling). */
const callOf = (name: string, args: Record<string, unknown> = {}): FnRequest => ({ body: args, headers: HEADERS, method: 'POST', path: `${TOOLS_PATH}${name.replace(/^workflow\./, '')}` })
const resourcesReq: FnRequest = { body: undefined, headers: HEADERS, method: 'GET', path: RESOURCES_PATH }

const http = (body: unknown, status = 200) => ({ ok: status < 400, status, body })

/**
 * Run the function steps the way a tool rule does — route, merge, plan, reply —
 * over the fetched/queried outputs given. `plan` runs after `merge`/`update`
 * because `workflow.submitStep`'s rule orders it there (its dispatch is
 * decided by whether the write landed, ADR-0006); every other tool's plan
 * reads nothing a write produced, so one order serves them all here.
 */
function run(req: FnRequest, fetched: Omit<StepOutputs, 'route' | 'plan'> = {}) {
  const route = routeOf({ request: req, deployment: DEPLOYMENT })
  const steps: StepOutputs = { ...fetched, route }
  if (!fetched.merge) steps.merge = mergeOf({ steps: { route, run: steps.run, steps: steps.steps } })
  steps.plan = planOf({ steps: { route, aliases: steps.aliases, index: steps.index, run: steps.run, steps: steps.steps, update: steps.update }, deployment: DEPLOYMENT })
  const out = reply({ request: req, steps, deployment: DEPLOYMENT })
  return { out, body: JSON.parse(out.json) as unknown, steps }
}
const result = (req: FnRequest, fetched?: Omit<StepOutputs, 'route' | 'plan'>) =>
  run(req, fetched).body as { content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }
const text = (r: { content: { text: string }[] }) => r.content[0].text

describe('the rule shape', () => {
  it('answers one catalog CallToolResult as JSON for a tool rule, and a refusal for a path it does not know', () => {
    const r = result(callOf('workflow.status'))
    expect(r.isError).toBe(true)
    expect(r.structuredContent!.errors).toHaveProperty('runId')
    const stray = run({ body: {}, headers: HEADERS, method: 'POST', path: '/api/workflow/nope' }).body as { isError?: boolean; structuredContent?: { errors?: { tool?: string } } }
    expect(stray.isError).toBe(true)
    expect(stray.structuredContent?.errors?.tool).toContain('/api/workflow/nope')
    expect(reply({ steps: {} }).json).toContain('The route step did not run')
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
    for (const name of ['workflow.cancel', 'workflow.await']) {
      const r = result(callOf(name, { runId: 'r' }))
      expect(r.isError, name).toBe(true)
      expect(r.structuredContent!.errors).toHaveProperty('tool')
    }
    expect(text(result(callOf('workflow.cancel', { runId: 'r' })))).toContain('runs are driven on the harness page')
    expect(text(result(callOf('workflow.await', { runId: 'r', until: 'terminal' })))).toContain('poll workflow.status')
    expect(text(result(callOf('workflow.submit', { runId: 'r', step: 's', outputs: {} }), { run: [], steps: [] }))).toBe('No such run: r')
    expect(result(callOf('echo')).structuredContent!.errors).toEqual({ tool: 'No such tool' })
  })
})

describe('the resources-list rule', () => {
  const aliases = http({ data: [{ alias: 'workflow' }, { alias: 'hello' }] })

  it('enumerates every discovered island for CE\'s mcp_handler to list (the step view is a static resource of the endpoint config)', () => {
    const { body } = run(resourcesReq, { aliases, index1: http(HELLO_INDEX) })
    expect(body).toEqual([
      { uri: 'ui://bffless/hello/islands/pick-line.html', name: 'hello: islands/pick-line.html', description: 'An island of the Hello implementation, served unchanged (spec 04).', mimeType: 'text/html;profile=mcp-app' },
      { uri: 'ui://bffless/hello/islands/line-viewer.html', name: 'hello: islands/line-viewer.html', description: 'An island of the Hello implementation, served unchanged (spec 04).', mimeType: 'text/html;profile=mcp-app' },
    ])
    expect(run(resourcesReq, { aliases: http('unauthorised', 401) }).body).toEqual([])
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
    expect(result(callOf('workflow.stepView', { runId: RUN_ID, step: 'greet/0/say' }), { run: [runRow()], steps: stepRows(), island: http(html) }).structuredContent!.errors).toEqual({ step: 'greet/0/say is a pipeline step, not an interactive one' })
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

  it('answers a waiting form off the row: the evaluated fields, their defaults as initial values, title and submit (Phase 4, Decision 2)', () => {
    const r = result(callOf('workflow.stepView', { runId: RUN_ID, step: 'review/0/confirm' }), { run: [runRow()], steps: formStepRows() })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe('review/0/confirm (form) is waiting — 3 fields: cover, notes, extra')
    expect(r.structuredContent).toEqual({
      runId: RUN_ID, step: 'review/0/confirm', impl: 'hello', workflow: 'interactive', kind: 'form', status: 'waiting',
      title: 'Review the card', submit: 'Approve',
      fields: REVIEW_INPUTS.fields,
      initial: { cover: null, notes: '## Notes\n\nHello, world!', extra: null },
    })
    const bare = formStepRows().map((row) => (row.key === 'review/0/confirm' ? { ...row, inputs: {} } : row))
    expect(result(callOf('workflow.stepView', { runId: RUN_ID, step: 'review/0/confirm' }), { run: [runRow()], steps: bare }).structuredContent!.errors).toEqual({
      step: "review/0/confirm: the form's evaluated fields were not recorded — complete it on the harness page",
    })
  })

  it('tells a text-only host how to open a form', () => {
    const status = result(callOf('workflow.status', { runId: RUN_ID }), { run: [runRow()], steps: formStepRows() })
    expect(text(status)).toContain(`call workflow.submitStep { runId: "${RUN_ID}", step: "review/0/confirm", values: {} } — the step's form renders in this chat`)
  })
})

// ---------------------------------------------------------------------------
// Driven runs (ADR-0006): the three tools that dispatch through the drive rule
// ---------------------------------------------------------------------------

const RECEIPT = { dispatched: true, runId: 'run_minted', repo: 'bffless/workflow-implementations', eventType: 'workflow-drive' }
const dispatched = http(RECEIPT, 202)
const refusedDrive = (code: string, message: string) => http({ code, message }, 400)

describe('workflow.start over the endpoint', () => {
  const index = http(HELLO_INDEX_WITH_DRIVER)
  const start = (args: Record<string, unknown>, fetched: Omit<StepOutputs, 'route' | 'plan'>) => run(callOf('workflow.start', args), fetched)

  it('mints the run id, dispatches the implementation’s driver, and answers pending', () => {
    const { body, steps } = start({ impl: 'hello', workflow: 'driven', inputs: {} }, { index, drive: dispatched })
    const r = body as { content: { text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean }
    expect(r.isError).toBeUndefined()
    const runId = r.structuredContent.runId as string
    expect(runId).toMatch(RUN_ID_PATTERN)
    expect(text(r).startsWith(`Dispatched run ${runId}`)).toBe(true)
    expect(text(r)).toContain('pending')
    expect(r.structuredContent).toMatchObject({ runId, pending: true, status: 'pending', currentSteps: [], waitingOn: [] })
    // What the drive rule was actually sent — one body, one id, the caller's own inputs.
    expect(steps.plan!.driveBody).toEqual({ id: runId, mode: 'run', impl: 'hello', workflow: 'driven', inputs: {} })
    expect(steps.plan!.isDrive).toBe(true)
    expect(steps.plan!.driveUrl).toBe('https://h.example/api/workflow/run/drive')
  })

  it('refuses an implementation that publishes no driver, naming the page it can be started on', () => {
    const r = start({ impl: 'hello', workflow: 'interactive', inputs: {} }, { index: http(HELLO_INDEX), drive: dispatched }).body as {
      isError?: boolean
      structuredContent: { errors: Record<string, string> }
    }
    expect(r.isError).toBe(true)
    expect(r.structuredContent.errors.tool).toContain('NO_DRIVER')
    expect(r.structuredContent.errors.tool).toContain('harness page')
  })

  it("refuses an unknown workflow, and an unreadable index, with the page's own refusal", () => {
    expect(start({ impl: 'hello', workflow: 'nope', inputs: {} }, { index }).body).toMatchObject({ structuredContent: { errors: { workflow: REFUSALS.noWorkflow } } })
    expect(start({ impl: 'hello', workflow: 'driven', inputs: {} }, { index: http('', 404) }).body).toMatchObject({
      structuredContent: { errors: { workflow: REFUSALS.noWorkflow } },
    })
  })

  it('requires impl, workflow and an object of inputs', () => {
    expect(start({ workflow: 'driven' }, {}).body).toMatchObject({ structuredContent: { errors: { impl: '`impl` is required' } } })
    expect(start({ impl: 'hello' }, {}).body).toMatchObject({ structuredContent: { errors: { workflow: '`workflow` is required' } } })
    const r = start({ impl: 'hello', workflow: 'driven', inputs: 'nope' }, { index }).body as { structuredContent: { errors: Record<string, string> } }
    expect(r.structuredContent.errors).toHaveProperty('inputs')
  })

  it("relays the drive rule's refusal by code, and calls anything else a failed dispatch", () => {
    const refused = start({ impl: 'hello', workflow: 'driven', inputs: {} }, { index, drive: refusedDrive('LEASE_LIVE', 'this run is open in tab_1') }).body as {
      isError?: boolean
      content: { text: string }[]
      structuredContent: { errors: Record<string, string> }
    }
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent.errors.drive).toBe('LEASE_LIVE')
    expect(text(refused)).toContain('this run is open in tab_1')
    const failed = start({ impl: 'hello', workflow: 'driven', inputs: {} }, { index, drive: http('boom', 500) }).body as {
      content: { text: string }[]
      structuredContent: { errors: Record<string, string> }
    }
    expect(failed.structuredContent.errors.drive).toBe('DISPATCH_FAILED')
    expect(text(failed)).toContain('500')
  })
})

describe('workflow.resume over the endpoint', () => {
  const resume = (args: Record<string, unknown>, fetched: Omit<StepOutputs, 'route' | 'plan'>) => run(callOf('workflow.resume', args), fetched)

  it('dispatches a driver to take the run over, and says so', () => {
    const { body, steps } = resume({ runId: RUN_ID }, { run: [runRow()], steps: stepRows(), drive: dispatched })
    const r = body as { content: { text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean }
    expect(r.isError).toBeUndefined()
    expect(text(r).startsWith(`Dispatched a driver to resume ${RUN_ID}`)).toBe(true)
    expect(steps.plan!.driveBody).toEqual({ id: RUN_ID, mode: 'resume' })
    expect(r.structuredContent).toMatchObject({ runId: RUN_ID, dispatched: true })
  })

  it('refuses an unknown run, a run that is over, and a drive rule refusal', () => {
    expect(text(resume({ runId: RUN_ID }, { run: [], steps: [] }).body as { content: { text: string }[] })).toBe(`No such run: ${RUN_ID}`)
    const over = resume({ runId: RUN_ID }, { run: [runRow({ status: 'succeeded' })], steps: [] }).body as { isError?: boolean; content: { text: string }[] }
    expect(over.isError).toBe(true)
    expect(text(over)).toContain('succeeded')
    const refused = resume({ runId: RUN_ID }, { run: [runRow()], steps: stepRows(), drive: refusedDrive('LEASE_LIVE', 'this run is open in tab_1') }).body as {
      isError?: boolean
      structuredContent: { errors: Record<string, string> }
    }
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent.errors.drive).toBe('LEASE_LIVE')
  })
})

describe('workflow.submitStep re-dispatches after its write', () => {
  const submit = (fetched: Omit<StepOutputs, 'route' | 'plan'>) =>
    run(callOf('workflow.submitStep', { runId: RUN_ID, step: 'pick/0/choose', values: { line: 'Hello, world!', index: 0 } }), fetched).body as {
      isError?: boolean
      content: { text: string }[]
      structuredContent: Record<string, unknown>
    }
  const rows = { run: [runRow()], steps: stepRows(), update: { id: 'rec_s4' } }

  it('tells the model the run was picked up again, on the same verdict', () => {
    const r = submit({ ...rows, drive: dispatched })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe(`Submitted pick/0/choose; Run ${RUN_ID} is running; a driver was dispatched to continue the run`)
    expect(r.structuredContent.dispatched).toBe(true)
  })

  it('says so when the dispatch was refused, without turning the accepted write into an error', () => {
    const r = submit({ ...rows, drive: refusedDrive('NO_DRIVER', 'this implementation publishes no driver repo — run it on the harness page instead') })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe(`Submitted pick/0/choose; Run ${RUN_ID} is running; not dispatched (NO_DRIVER): resume it on the harness page`)
    expect(r.structuredContent.dispatched).toBe(false)
  })

  // `LEASE_LIVE` is the one refusal that is good news: a page holds the lease,
  // so the submit landed on a run that is already being driven — and pointing
  // the model at the harness page to "resume" it would be pointing it at the
  // tab already doing the work.
  it('does not send the model to the harness page when a page is already driving the run', () => {
    const r = submit({ ...rows, drive: refusedDrive('LEASE_LIVE', 'this run is open in tab_1') })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toBe(`Submitted pick/0/choose; Run ${RUN_ID} is running; not dispatched: a page is driving this run`)
    expect(r.structuredContent.dispatched).toBe(false)
  })

  it('dispatches nothing when no write landed: a refused submit, and the render path', () => {
    const lost = run(callOf('workflow.submitStep', { runId: RUN_ID, step: 'pick/0/choose', values: { line: 'x', index: 0 } }), { run: [runRow()], steps: stepRows() })
    expect(lost.steps.plan!.isDrive).toBe(false)
    const opened = run(callOf('workflow.submitStep', { runId: RUN_ID, step: 'pick/0/choose', values: {} }), { run: [runRow()], steps: stepRows() })
    expect(opened.steps.plan!.isDrive).toBe(false)
    const r = opened.body as { content: { text: string }[]; structuredContent: Record<string, unknown> }
    expect(text(r)).toContain('no values are needed from you')
    expect(r.structuredContent).not.toHaveProperty('dispatched')
  })
})

describe('workflow.status while a dispatched run has no row yet', () => {
  it('answers the pending snapshot inside the window, and No such run outside it', () => {
    const pending = mintRunId(Date.now() - 60_000)
    const r = result(callOf('workflow.status', { runId: pending }), { run: [], steps: [] })
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent).toEqual({ runId: pending, status: 'pending', currentSteps: [], outputs: {}, steps: {}, waitingOn: [] })
    expect(text(r)).toContain('not started yet')
    const stale = mintRunId(Date.now() - 11 * 60_000)
    expect(text(result(callOf('workflow.status', { runId: stale }), { run: [], steps: [] }))).toBe(`No such run: ${stale}`)
    expect(text(result(callOf('workflow.status', { runId: 'nope' }), { run: [], steps: [] }))).toBe('No such run: nope')
  })
})
