// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { POSTER_A, RUN_ID, formStepRows, runRow, stepRows } from './fixtures/index'
import { handler as merge } from './merge'
import { TOOLS_PATH, handler as routeOf, type FnRequest } from './route'

const DEPLOYMENT = { owner: 'o', repo: 'r', commitSha: 'c', alias: 'workflow' }
const request = (name: string, body: unknown): FnRequest => ({ body, headers: { host: 'h.example' }, method: 'POST', path: `${TOOLS_PATH}${name.replace(/^workflow\./, '')}` })
const call = (name: string, args: Record<string, unknown>) =>
  routeOf({ request: request(name, args), deployment: DEPLOYMENT })
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
    expect(text(done)).toBe('greet/0/say is a pipeline step, not an interactive one')
    const rows = stepRows().map((row) => (row.key === STEP ? { ...row, status: 'succeeded' } : row))
    expect(text(merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: STEP, outputs: {} }), run: run(), steps: rows } }))).toBe(`${STEP} is succeeded, not waiting`)
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
    for (const args of [{ runId: RUN_ID, step: STEP }, { runId: RUN_ID, step: STEP, values: {} }]) {
      const panel = merge({ steps: { route: call('workflow.submitStep', args), run: run(), steps: stepRows() } })
      expect(panel.update).toBe(false)
      expect(panel.result.isError).toBeUndefined()
      expect(text(panel)).toContain(`Run ${RUN_ID} is running, waiting on ${STEP} (island; outputs: line (string, required), index (number)). The step's island is rendered`)
      expect(panel.result.structuredContent).toMatchObject({ step: STEP, ui: 'rendered', waitingOn: [{ key: STEP }] })
    }
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

describe('merge: form steps (Phase 4, Decisions 2–3)', () => {
  const FORM = 'review/0/confirm'
  it('submitStep validates a form with the page’s validateFormOutputs and records the chosen ref, not its path', () => {
    const m = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: { cover: POSTER_A.path, notes: 'ok', extra: null } }), run: run(), steps: formStepRows() } })
    expect(m.update).toBe(true)
    expect(m.recordId).toBe('rec_s6')
    expect(m.fields).toMatchObject({ status: 'succeeded', outputs: { cover: POSTER_A, notes: 'ok', extra: null } })
    expect(text(m)).toBe(`Submitted ${FORM}; Run ${RUN_ID} is running`)
  })

  it('refuses per field, exactly as the page’s form pane words it', () => {
    const m = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: { notes: 'x' } }), run: run(), steps: formStepRows() } })
    expect(m.update).toBe(false)
    expect(errors(m)).toEqual({ cover: 'This field is required' })
    const outside = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: { cover: 'workflows/elsewhere.svg' } }), run: run(), steps: formStepRows() } })
    expect(errors(outside)).toHaveProperty('cover')
  })

  it('opens the panel for a form with no values, and keeps workflow.submit / annotate island-only', () => {
    const panel = merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: {} }), run: run(), steps: formStepRows() } })
    expect(panel.update).toBe(false)
    expect(text(panel)).toContain(`The step's form is rendered for the person to complete ${FORM} in`)
    expect(text(merge({ steps: { route: call('workflow.submit', { runId: RUN_ID, step: FORM, outputs: { cover: POSTER_A.path } }), run: run(), steps: formStepRows() } }))).toBe(`${FORM} is a form step — complete it with workflow.submitStep { values }`)
    expect(text(merge({ steps: { route: call('workflow.annotate', { runId: RUN_ID, step: FORM, summary: 's' }), run: run(), steps: formStepRows() } }))).toBe(`${FORM} is a form step, not an island`)
    const bare = formStepRows().map((row) => (row.key === FORM ? { ...row, inputs: {} } : row))
    expect(text(merge({ steps: { route: call('workflow.submitStep', { runId: RUN_ID, step: FORM, values: { cover: POSTER_A.path } }), run: run(), steps: bare } }))).toBe(`${FORM}: the form's evaluated fields were not recorded — complete it on the harness page`)
  })
})
