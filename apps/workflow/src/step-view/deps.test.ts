// @vitest-environment node
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { readStepView, stepViewDeps, submitFormValues, type ServerCall, type StepViewData } from './deps'

const VIEW: StepViewData = {
  runId: 'run_1',
  step: 'pick/0/choose',
  impl: 'hello',
  workflow: 'interactive',
  kind: 'island',
  status: 'waiting',
  src: 'islands/pick-line.html',
  arguments: { lines: ['a', 'b'] },
  outputs: { line: { type: 'string', required: true } },
  html: '<!doctype html><script>pick</script>',
}

const ok = (structuredContent: Record<string, unknown> = {}, meta?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  structuredContent,
  ...(meta ? { _meta: meta } : {}),
})
const refused = (text: string, structuredContent?: Record<string, unknown>, meta?: Record<string, unknown>): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text }],
  ...(structuredContent ? { structuredContent } : {}),
  ...(meta ? { _meta: meta } : {}),
})

/** A `callServerTool` that answers from a script and records what it was asked. */
function recorder(answers: Record<string, CallToolResult | ((args: Record<string, unknown>) => CallToolResult)>) {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = []
  const call: ServerCall = async (params) => {
    calls.push(params)
    const answer = answers[params.name]
    if (!answer) throw new Error(`unexpected tool ${params.name}`)
    return typeof answer === 'function' ? answer(params.arguments) : answer
  }
  return { call, calls }
}

const hooks = () => {
  const logs: string[] = []
  let submitted = 0
  return { onLog: (line: string) => void logs.push(line), onSubmitted: () => void submitted++, logs, submitted: () => submitted }
}

describe('readStepView', () => {
  it('reads a stepView answer and refuses a malformed or errored one', () => {
    expect(readStepView(ok({ ...VIEW }))).toEqual(VIEW)
    expect(() => readStepView(refused('No such run: x'))).toThrow('No such run: x')
    expect(() => readStepView(ok({ ...VIEW, html: '' }))).toThrow('without html')
  })
})

describe('stepViewDeps', () => {
  it("routes the island's pipeline calls through workflow.pipeline, run-scoped", async () => {
    const r = recorder({ 'workflow.pipeline': ok({ text: 'HI' }, { bffless: { status: 200 } }) })
    const deps = stepViewDeps(r.call, VIEW, hooks())
    const res = await deps.http('/api/hello/echo', { method: 'POST', body: { text: 'hi', upper: true } })
    expect(r.calls).toEqual([{ name: 'workflow.pipeline', arguments: { runId: 'run_1', step: 'pick/0/choose', name: 'echo', arguments: { text: 'hi', upper: true }, method: 'POST' } }])
    expect(res).toEqual({ ok: true, status: 200, body: { text: 'HI' } })
    await deps.http('/api/hello/job', { method: 'GET', query: { id: '7' } })
    expect(r.calls[1].arguments).toMatchObject({ name: 'job', arguments: { id: '7' }, method: 'GET' })
  })

  it('turns a relayed pipeline error into the non-2xx shape IslandHost reports', async () => {
    const r = recorder({ 'workflow.pipeline': refused('HTTP_500: boom', undefined, { bffless: { status: 500 } }) })
    const res = await stepViewDeps(r.call, VIEW, hooks()).http('/api/hello/fail', { method: 'POST', body: {} })
    expect(res).toEqual({ ok: false, status: 500, body: { error: 'HTTP_500: boom' } })
  })

  it("serves the island's own HTML and nothing else", async () => {
    const deps = stepViewDeps(recorder({}).call, VIEW, hooks())
    expect(await deps.fetchText('/w/hello/islands/pick-line.html')).toEqual({ ok: true, status: 200, text: VIEW.html })
    expect((await deps.fetchText('/w/hello/other.html')).status).toBe(404)
  })

  it('submits through workflow.submit and reports the server’s per-output refusals', async () => {
    const h = hooks()
    const r = recorder({
      'workflow.submit': (args) => (Object.keys(args.outputs as object).length ? ok({ runId: 'run_1' }) : refused('{"line":"This field is required"}', { errors: { line: 'This field is required' } })),
    })
    const deps = stepViewDeps(r.call, VIEW, h)
    expect(await deps.onSubmit({})).toEqual({ ok: false, errors: { line: 'This field is required' } })
    expect(h.submitted()).toBe(0)
    expect(await deps.onSubmit({ line: 'a', index: 0 })).toEqual({ ok: true })
    expect(h.submitted()).toBe(1)
    expect(r.calls[1]).toEqual({ name: 'workflow.submit', arguments: { runId: 'run_1', step: 'pick/0/choose', outputs: { line: 'a', index: 0 } } })
  })

  it('annotates and signs through the endpoint', async () => {
    const r = recorder({
      'workflow.annotate': ok({}),
      'workflow.sign': (args) => (args.path === 'workflows/x' ? ok({ url: 'https://storage/x?sig', expiresIn: 3600 }) : refused('path must be an uploads-relative key under workflows/ with no traversal')),
    })
    const deps = stepViewDeps(r.call, VIEW, hooks())
    expect(await deps.onAnnotate({ annotations: [{ level: 'notice', message: 'm' }] })).toEqual({ ok: true })
    expect(r.calls[0].arguments).toEqual({ runId: 'run_1', step: 'pick/0/choose', annotations: [{ level: 'notice', message: 'm' }] })
    expect(await deps.sign('workflows/x')).toEqual({ url: 'https://storage/x?sig', expiresIn: 3600 })
    await expect(deps.sign('../x')).rejects.toThrow('no traversal')
    expect(r.calls[1].arguments).toEqual({ runId: 'run_1', path: 'workflows/x' })
  })
})

const FORM_VIEW = {
  runId: 'run_1', step: 'review/0/confirm', impl: 'hello', workflow: 'interactive', kind: 'form', status: 'waiting',
  title: 'Review the card', submit: 'Approve',
  fields: { cover: { type: 'choice', options: [{ path: 'workflows/x/a.svg', name: 'a.svg', contentType: 'image/svg+xml', size: 1, url: '/api/uploads/workflows/x/a.svg' }], required: true }, notes: { type: 'markdown', default: 'n' } },
  initial: { cover: null, notes: 'n' },
}

describe('readStepView: forms', () => {
  it('reads a form answer, defaults description and initial values', () => {
    const view = readStepView(ok(FORM_VIEW))
    expect(view.kind).toBe('form')
    if (view.kind !== 'form') throw new Error('not a form')
    expect(view.title).toBe('Review the card')
    expect(view.submit).toBe('Approve')
    expect(Object.keys(view.fields)).toEqual(['cover', 'notes'])
    expect(view.initial).toEqual({ cover: null, notes: 'n' })
    expect(() => readStepView(ok({ ...FORM_VIEW, fields: undefined }))).toThrow('workflow.stepView answered without fields')
  })
})

describe('submitFormValues', () => {
  it('sends workflow.submitStep { runId, step, values } and reads the verdict the way the island path does', async () => {
    const { call, calls } = recorder({ 'workflow.submitStep': ok({ runId: 'run_1', step: 'review/0/confirm' }) })
    const view = readStepView(ok(FORM_VIEW))
    if (view.kind !== 'form') throw new Error('not a form')
    expect(await submitFormValues(call, view, { cover: 'workflows/x/a.svg', notes: 'n' })).toEqual({ ok: true })
    expect(calls).toEqual([{ name: 'workflow.submitStep', arguments: { runId: 'run_1', step: 'review/0/confirm', values: { cover: 'workflows/x/a.svg', notes: 'n' } } }])
    const refusing = recorder({ 'workflow.submitStep': refused('{"cover":"This field is required"}', { errors: { cover: 'This field is required' } }) })
    expect(await submitFormValues(refusing.call, view, {})).toEqual({ ok: false, errors: { cover: 'This field is required' } })
    const bare = recorder({ 'workflow.submitStep': refused('A harness tab still drives this run') })
    expect(await submitFormValues(bare.call, view, {})).toEqual({ ok: false, errors: { values: 'A harness tab still drives this run' } })
  })
})
