// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { RUN_ID, runRow, stepRows } from './fixtures/index'
import { handler as merge } from './merge'
import { handler as routeOf, type FnRequest } from './route'

const DEPLOYMENT = { owner: 'o', repo: 'r', commitSha: 'c', alias: 'workflow' }
const request = (body: unknown): FnRequest => ({ body, headers: { host: 'h.example' }, method: 'POST', path: '/api/workflow/mcp' })
const call = (name: string, args: Record<string, unknown>) =>
  routeOf({ request: request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), deployment: DEPLOYMENT })
const STEP = 'pick/0/choose'
const run = (over: Record<string, unknown> = {}) => [runRow(over)]
const text = (m: ReturnType<typeof merge>) => m.result.content[0].text
const errors = (m: ReturnType<typeof merge>) => (m.result.structuredContent?.errors ?? {}) as Record<string, string>

describe('merge: refusals', () => {
  it('needs a run, a running one, and a lapsed lease', () => {
    expect(errors(merge({ steps: { route: call('workflow.submit', { step: STEP, outputs: {} }) } }))).toHaveProperty('runId')
    expect(text(merge({ steps: { route: call('workflow.submit', { runId: 'nope', step: STEP, outputs: {} }), run: [], steps: [] } }))).toBe('No such run: nope')
    expect(errors(merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: STEP, outputs: {} }), run: run({ status: 'succeeded' }), steps: stepRows() } }))).toHaveProperty('runId')
    const held = merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: STEP, outputs: {} }), run: run({ leaseOwner: 'tab', leaseUntil: Date.now() + 30_000 }), steps: stepRows() } })
    expect(held.update).toBe(false)
    expect(errors(held)).toHaveProperty('lease')
    const lapsed = merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: STEP, outputs: { line: 'x' } }), run: run({ leaseOwner: 'tab', leaseUntil: Date.now() - 1 }), steps: stepRows() } })
    expect(lapsed.update).toBe(true)
  })

  it('needs a waiting island step', () => {
    const r = call('workflow.submit', { runId: RUN_ID, step: 'nope/0/x', outputs: {} })
    expect(text(merge({ steps: { route: r, run: run(), steps: stepRows() } }))).toBe('No such step: nope/0/x')
    const done = merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: 'greet/0/say', outputs: {} }), run: run(), steps: stepRows() } })
    expect(text(done)).toBe('greet/0/say is a pipeline step, not an island')
    const rows = stepRows().map((row) => (row.key === STEP ? { ...row, status: 'succeeded' } : row))
    expect(text(merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: STEP, outputs: {} }), run: run(), steps: rows } }))).toBe(`${STEP} is succeeded, not waiting`)
    const form = stepRows().map((row) => (row.key === STEP ? { ...row, kind: 'form' } : row))
    expect(text(merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: STEP, outputs: {} }), run: run(), steps: form } }))).toContain('form steps are not served')
  })
})

describe('merge: submit', () => {
  it('validates with the page’s validator and writes the full row', () => {
    const m = merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: STEP, outputs: { line: 'Hello, world!', index: 0 } }), run: run(), steps: stepRows() } })
    expect(m.update).toBe(true)
    expect(m.recordId).toBe('rec_s4')
    expect(m.fields).toMatchObject({ status: 'succeeded', outputs: { line: 'Hello, world!', index: 0 }, inputs: { lines: ['Hello, world!', 'Hello, studio!'], words: [{ w: 'Hello' }] }, attempt: 1 })
    expect(typeof m.fields?.finishedAt).toBe('number')
    expect(Object.keys(m.fields ?? {}).sort()).toEqual(['annotations', 'attempt', 'error', 'finishedAt', 'heartbeatAt', 'inputs', 'log', 'logId', 'outputs', 'response', 'startedAt', 'status', 'summary'])
    expect(text(m)).toBe(`Submitted ${STEP}; Run ${RUN_ID} is running`)
    expect((m.result.structuredContent?.snapshot as { steps: Record<string, string> }).steps[STEP]).toBe('succeeded')
  })

  it('refuses a bad submit per output, exactly as IslandHost words it', () => {
    const m = merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: STEP, outputs: {} }), run: run(), steps: stepRows() } })
    expect(m.update).toBe(false)
    expect(errors(m)).toEqual({ line: 'This field is required' })
    expect(text(m)).toBe('{"line":"This field is required"}')
    const typed = merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: STEP, outputs: { line: 'x', index: 'one' } }), run: run(), steps: stepRows() } })
    expect(errors(typed)).toEqual({ index: 'Expected a number value' })
  })

  it('submitStep with values submits; without values it shows the panel', () => {
    const withValues = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: STEP, values: { line: 'a' } }), run: run(), steps: stepRows() } })
    expect(withValues.update).toBe(true)
    const panel = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: STEP }), run: run(), steps: stepRows() } })
    expect(panel.update).toBe(false)
    expect(panel.result.isError).toBeUndefined()
    expect(text(panel)).toBe(`Run ${RUN_ID} is running, waiting on ${STEP} (island); pick in the panel to complete ${STEP}`)
    expect(panel.result.structuredContent).toMatchObject({ step: STEP, waitingOn: [{ key: STEP }] })
  })
})

describe('merge: annotate', () => {
  it('appends within the budget and sets a summary', () => {
    const m = merge({ steps: { route: call('workflow.annotate', { runId: RUN_ID, step: STEP, annotations: [{ level: 'notice', message: 'Previewed a' }], summary: 'picked a' }), run: run(), steps: stepRows() } })
    expect(m.update).toBe(true)
    expect(m.fields).toMatchObject({ status: 'waiting', annotations: [{ level: 'notice', message: 'Previewed a' }], summary: 'picked a' })
    expect(text(m)).toBe('ok')
  })

  it('refuses bad or over-budget annotations with the page’s messages', () => {
    const bad = merge({ steps: { route: call('workflow.annotate', { runId: RUN_ID, step: STEP, annotations: [{ level: 'loud', message: 'm' }] }), run: run(), steps: stepRows() } })
    expect(bad.update).toBe(false)
    expect(text(bad)).toBe('annotations[0]: `level` must be notice, warning or error')
    const existing = Array.from({ length: 100 }, (_, i) => ({ level: 'notice', message: `n${i}` }))
    const rows = stepRows().map((row) => (row.key === STEP ? { ...row, annotations: existing } : row))
    const full = merge({ steps: { route: call('workflow.annotate', { runId: RUN_ID, step: STEP, annotations: [{ level: 'notice', message: 'one more' }] }), run: run(), steps: rows } })
    expect(full.update).toBe(false)
    expect(text(full)).toContain('at most 100')
  })
})
