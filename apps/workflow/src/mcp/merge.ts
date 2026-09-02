/**
 * `merge` — the MCP endpoint rule's write step (spec 10 §Islands and the run
 * view; Phase 2 plan, Task 10 + Decision 7): what `workflow.submit`,
 * `workflow.submitStep` and `workflow.annotate` may write to the waiting
 * island's step row, decided from the run row and step rows the pipeline read.
 *
 * The validators are the page's own — `validateDeclared(outputDecls(step))`
 * is what `completeIslandStep` runs, `annotateEvent` is what the page's
 * annotate runs — so an island in an agent host is judged exactly as on the
 * harness page (D12). The write is `run-step`'s read-merge-write (the full
 * column set), and it is refused while a harness tab still drives the run:
 * the endpoint takes no lease and seals nothing; the run continues when it is
 * resumed on the harness (05). Islands only: a form's evaluated fields live in
 * the page's state; a submitted step's `summary` needs run contexts — both
 * recorded gaps of the prototype.
 */
import { errorResult, snapshotText, textResult, type CallToolResult } from '@bffless/workflow-agent-tools'
import { toDefinition, type Step } from '@bffless/workflow-lint/definition'
import { outputDecls, validateDeclared } from '../lib/runner/adapters/declared'
import { annotateEvent } from '../lib/runner/adapters/island'
import type { Annotation } from '../lib/runner/types'
import { snapshotOf } from './reply'
import { fieldsOf, recordIdOf, rows, type Row } from './rows'
import type { Route } from './route'

/** The columns `run-step`'s upsert writes; the `data_update` step lists the same. */
export const STEP_ROW_FIELDS = [
  'status',
  'attempt',
  'inputs',
  'response',
  'outputs',
  'error',
  'summary',
  'annotations',
  'log',
  'logId',
  'startedAt',
  'finishedAt',
  'heartbeatAt',
] as const

export interface MergeResult {
  /** The condition of the `update` step. */
  update: boolean
  recordId: string | null
  /** The full row column set, merged — only when `update`. */
  fields?: Record<string, unknown>
  /** What `reply` answers for the write tool: the refusal, or the acceptance. */
  result: CallToolResult
  key: string
}

const WRITE_TOOLS = new Set(['workflow.submit', 'workflow.submitStep', 'workflow.annotate'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function refuse(key: string, message: string, extra: Record<string, unknown> = {}): MergeResult & { update: false } {
  return { update: false, recordId: null, result: errorResult(message, { errors: { [key]: message }, ...extra }), key: '' }
}

/** The raw step declaration of (job, stepId) in the run's definition snapshot, typed through workflow-lint's model. */
function declaredStep(definition: unknown, job: string, stepId: string): Step | undefined {
  try {
    const def = toDefinition(definition)
    return def.jobs[job]?.steps.find((step) => step.id === stepId)
  } catch {
    return undefined
  }
}

export function handler(data: { steps: { route?: Route; run?: unknown; steps?: unknown } }): MergeResult {
  const route = data.steps?.route
  if (!route || !WRITE_TOOLS.has(route.tool)) {
    return { update: false, recordId: null, result: errorResult('Not a write', { errors: { tool: 'Not a write' } }), key: '' }
  }
  const key = route.key
  const now = Date.now()

  if (route.runId === '') return refuse('runId', 'Pass runId — the MCP endpoint has no current run')
  if (key === '') return refuse('step', '`step` is required')
  const runRow = rows(data.steps.run)[0]
  if (!runRow) return { ...refuse('runId', `No such run: ${route.runId}`), key }
  const run = fieldsOf(runRow)
  if (run.status !== 'running') return { ...refuse('runId', `Run ${route.runId} is ${String(run.status)}; only a running run takes a submit`), key }
  const leaseOwner = typeof run.leaseOwner === 'string' ? run.leaseOwner : ''
  const leaseUntil = typeof run.leaseUntil === 'number' ? run.leaseUntil : 0
  if (leaseOwner !== '' && leaseUntil > now) {
    return {
      ...refuse('lease', `A harness tab still drives this run (lease until ${new Date(leaseUntil).toISOString()}) — close it or wait for the lease to lapse`),
      key,
    }
  }

  const stepRows = rows(data.steps.steps)
  const rowRecord = stepRows.find((row) => fieldsOf(row).key === key)
  if (!rowRecord) return { ...refuse('step', `No such step: ${key}`), key }
  const row = fieldsOf(rowRecord)
  const recordId = recordIdOf(rowRecord)
  if (row.kind === 'form') return { ...refuse('step', 'form steps are not served over the MCP endpoint yet — complete it on the harness'), key }
  if (row.kind !== 'island') return { ...refuse('step', `${key} is a ${String(row.kind)} step, not an island`), key }
  if (row.status !== 'waiting') return { ...refuse('step', `${key} is ${String(row.status)}, not waiting`), key }
  if (recordId === null) return { ...refuse('step', `${key}: the step row has no record id`), key }

  const stepRowsFields = stepRows.map(fieldsOf)
  const snapshotWith = (patched: Row) =>
    snapshotOf(
      run,
      stepRowsFields.map((r) => (r.key === key ? patched : r)),
    )
  const base: Record<string, unknown> = {}
  for (const field of STEP_ROW_FIELDS) base[field] = Object.hasOwn(row, field) ? row[field] : null

  // --- submit: workflow.submit { outputs } or workflow.submitStep { values }
  if (route.tool === 'workflow.submit' || route.tool === 'workflow.submitStep') {
    const raw = route.tool === 'workflow.submit' ? route.args.outputs : route.args.values
    if (raw === undefined && route.tool === 'workflow.submitStep') {
      // No values: the host renders the step view (linked from the tool) and the island completes it.
      const snapshot = snapshotOf(run, stepRowsFields)
      return {
        update: false,
        recordId,
        key,
        result: textResult(`${snapshotText(snapshot)}; pick in the panel to complete ${key}`, { ...snapshot, step: key }),
      }
    }
    if (!isPlainObject(raw)) {
      return { ...refuse(route.tool === 'workflow.submit' ? 'outputs' : 'values', 'Expected an object of outputs'), key }
    }
    const step = declaredStep(run.definition, String(row.job ?? ''), String(row.step ?? ''))
    if (!step) return { ...refuse('step', `${key}: the run's definition snapshot does not declare it`), key }
    const { outputs, errors } = validateDeclared(outputDecls(step), raw, { defaultType: 'json' })
    if (Object.keys(errors).length > 0) {
      // IslandHost's wording: the per-output messages as the text, the map as structuredContent.errors.
      return { update: false, recordId, key, result: errorResult(JSON.stringify(errors), { errors }) }
    }
    const fields = { ...base, status: 'succeeded', outputs, finishedAt: now }
    const snapshot = snapshotWith({ ...row, ...fields })
    return {
      update: true,
      recordId,
      key,
      fields,
      result: textResult(`Submitted ${key}; ${snapshotText(snapshot)}`, { runId: route.runId, step: key, snapshot }),
    }
  }

  // --- annotate: workflow.annotate { annotations?, summary? }
  const existing = Array.isArray(row.annotations) ? (row.annotations as Annotation[]) : []
  const { runId: _r, step: _s, ...args } = route.args
  void _r
  void _s
  const event = annotateEvent(key, args, now, existing)
  if ('error' in event) return { update: false, recordId, key, result: errorResult(event.error, { errors: { annotations: event.error } }) }
  const fields = {
    ...base,
    annotations: event.annotations ? [...existing, ...event.annotations] : existing,
    summary: event.summary ?? (typeof row.summary === 'string' ? row.summary : null),
  }
  return { update: true, recordId, key, fields, result: textResult('ok', { runId: route.runId, step: key }) }
}
