/**
 * `reply` — the last function step of every MCP tool rule (spec 10, D22 GA;
 * Phase 3 plan, Task B1): one catalog `CallToolResult`, built with the
 * catalog's own builders (D19) and worded as the harness page words it
 * (`src/agent/executors.ts` is the reference; the parity tests hold the two
 * together), pre-serialized for the `respond` step (`{{{steps.reply.json}}}`,
 * apps#381). CE's `mcp_handler` passes a `content[]` body through verbatim.
 * The resources-list rule answers the array CE's `resources.list` reads.
 */
import {
  errorResult,
  snapshotFromRows,
  snapshotText,
  textResult,
  toolByName,
  type CallToolResult,
  type RunRowLike,
  type RunSnapshot,
  type StepRowLike,
} from '@bffless/workflow-agent-tools'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { parse } from 'yaml'
import { describeText, describeWorkflow } from '../lib/describe'
import { RESOURCE_MIME, isHostTool } from './hostTools'
import { runIdTime, workflowId } from './ids'
import type { Plan } from './plan'
import { NEED_IMPL_WORKFLOW, NEED_RUN_ID, NOT_CONFINED, REFUSALS } from './refusals'
import { fieldsOf, rows, runsWithWaiting, stepUpdated, type Row } from './rows'
import type { FnDeployment, FnRequest, Route } from './route'
import { pipelineError, pipelineResult } from './toolResults'

/** What an `http_request` step with `failOnError: false` answers. */
export interface HttpStep {
  ok?: boolean
  status?: number
  statusText?: string
  body?: unknown
}

export interface StepOutputs {
  route?: Route
  plan?: Plan
  run?: unknown
  steps?: unknown
  runs?: unknown
  waiting?: unknown
  aliases?: HttpStep
  index?: HttpStep
  index1?: HttpStep
  index2?: HttpStep
  index3?: HttpStep
  yaml?: HttpStep
  island?: HttpStep
  signed?: { url?: string }
  /** Task 10: the write branch's verdict. */
  merge?: { update?: boolean; result?: CallToolResult }
  update?: unknown
  pipelinePost?: HttpStep
  pipelineGet?: HttpStep
  /** Task 11: what the harness's own `run/drive` rule answered (ADR-0006). */
  drive?: HttpStep
}

export interface Reply {
  json: string
}

/**
 * `workflow.cancel` alone: cancelling is a write to the live run's state that
 * only the surface holding the run can make (spec 10), and no rule of this
 * harness performs it. `workflow.await` is refused too, in its own words — a
 * stateless POST cannot wait. Everything else the catalog names is served
 * here; `start` and `resume` became dispatches through the drive rule
 * (ADR-0006), which is why they left this set.
 */
const NOT_SERVED = new Set(['workflow.cancel'])
/** How long after a run id was minted its absent row still reads as `pending` rather than as no run at all (ADR-0006: the job writes its first row in about a minute). */
export const PENDING_WINDOW_MS = 10 * 60_000
const WRITE_TOOLS = new Set(['workflow.submit', 'workflow.annotate', 'workflow.submitStep'])
const RUNS_DEFAULT = 20
const RUNS_MAX = 50
const SIGN_EXPIRES_IN = 3600

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A step's body as an object, whether or not the call succeeded — a refusal is JSON too. */
function bodyObject(body: unknown): Record<string, unknown> | null {
  if (isPlainObject(body)) return body
  if (typeof body === 'string') {
    try {
      const parsed: unknown = JSON.parse(body)
      return isPlainObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

function jsonBody(step: HttpStep | undefined): Record<string, unknown> | null {
  return step?.ok === true ? bodyObject(step.body) : null
}

function refuse(key: string, message: string, extra: Record<string, unknown> = {}): CallToolResult {
  return errorResult(message, { errors: { [key]: message }, ...extra })
}

// ---------------------------------------------------------------------------
// Discovery: the index files the fan-out fetched, in `plan.aliases` order
// ---------------------------------------------------------------------------

interface Listed {
  alias: string
  name: string
  version?: string
  preview: boolean
  error?: string
  workflows: Array<{ id: string; file: string; name: string; description?: string; headlessSafe: boolean }>
  islands: string[]
}

/** An implementation from its `index.json` (06) — the page's `toImplementation` restated for the list tool's shape. */
function implementationOf(alias: string, step: HttpStep | undefined): Listed | null {
  if (!step || step.ok !== true) return null
  const body = jsonBody(step)
  if (!body) return { alias, name: alias, preview: false, error: 'index.json is not valid JSON', workflows: [], islands: [] }
  const workflows = (Array.isArray(body.workflows) ? body.workflows : [])
    .filter((entry: unknown): entry is Record<string, unknown> => isPlainObject(entry) && typeof entry.file === 'string')
    .map((entry) => ({
      id: workflowId(entry.file as string),
      file: entry.file as string,
      name: str(entry.name) ?? workflowId(entry.file as string),
      ...(str(entry.description) === undefined ? {} : { description: entry.description as string }),
      headlessSafe: entry.headlessSafe === true,
    }))
  const islands = (Array.isArray(body.islands) ? body.islands : []).filter((entry: unknown): entry is string => typeof entry === 'string')
  return {
    alias: str(body.impl) ?? alias,
    name: str(body.name) ?? alias,
    ...(str(body.version) === undefined ? {} : { version: body.version as string }),
    preview: false,
    workflows,
    islands,
  }
}

function discovered(steps: StepOutputs): Listed[] {
  const plan = steps.plan
  if (!plan) return []
  const fetched = [steps.index1, steps.index2, steps.index3]
  return plan.aliases
    .map((alias, i) => implementationOf(alias, fetched[i]))
    .filter((impl): impl is Listed => impl !== null)
}

function listText(implementations: Array<Omit<Listed, 'islands'>>): string {
  const lines = implementations.map((impl) => {
    const workflows = impl.workflows.map((workflow) => `${workflow.id}${workflow.headlessSafe ? ' (headless-safe)' : ''}`).join(', ')
    return `${impl.alias} — ${impl.name}${impl.version ? ` v${impl.version}` : ''}${impl.error ? ` (unusable: ${impl.error})` : ''}: ${workflows || 'no workflows'}`
  })
  return lines.length === 0 ? 'No implementations are published here' : lines.join('\n')
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function list(route: Route, steps: StepOutputs): CallToolResult {
  const only = route.impl === '' ? undefined : route.impl
  if (only === undefined && steps.aliases?.ok !== true) return refuse('discovery', REFUSALS.discovery)
  const implementations = discovered(steps).map(({ islands, ...impl }) => {
    void islands
    return impl
  })
  if (only !== undefined && implementations.length === 0) return refuse('impl', `No implementation "${only}" is published here`)
  const skipped = steps.plan?.skipped ?? []
  const text = listText(implementations) + (skipped.length ? `\n(+${skipped.length} more implementation${skipped.length === 1 ? '' : 's'} not listed by the prototype endpoint)` : '')
  return textResult(text, { implementations, ...(skipped.length ? { skipped } : {}) })
}

function describe(route: Route, steps: StepOutputs): CallToolResult {
  if (route.impl === '') return refuse('impl', '`impl` is required')
  if (route.workflow === '') return refuse('workflow', '`workflow` is required')
  if (!route.isDescribe) return refuse('discovery', REFUSALS.discovery)
  if (steps.index?.ok !== true) return refuse('workflow', REFUSALS.noWorkflow)
  const plan = steps.plan
  if (!plan?.hasYaml || !plan.listing) return refuse('workflow', REFUSALS.noWorkflow)
  const yaml = steps.yaml
  if (yaml?.ok !== true || typeof yaml.body !== 'string') return refuse('workflow', REFUSALS.fileUnreadable)
  const entry = plan.listing
  const listing = {
    file: entry.file as string,
    name: str(entry.name) ?? route.workflow,
    ...(str(entry.description) === undefined ? {} : { description: entry.description as string }),
    inputs: typeof entry.inputs === 'number' ? entry.inputs : 0,
    jobs: typeof entry.jobs === 'number' ? entry.jobs : 0,
    headlessSafe: entry.headlessSafe === true,
  }
  let described: ReturnType<typeof describeWorkflow>
  try {
    const def = toDefinition(parse(yaml.body))
    described = describeWorkflow({ impl: route.impl, workflow: route.workflow, listing, def })
  } catch {
    return refuse('workflow', REFUSALS.doesNotLint)
  }
  return textResult(describeText(described), { ...described })
}

/** The run a run-scoped tool named, as rows, or the page's refusal. */
function resolveRun(route: Route, steps: StepOutputs): { ok: true; run: Row; stepRows: Row[] } | { ok: false; result: CallToolResult } {
  if (route.runId === '') return { ok: false, result: refuse('runId', NEED_RUN_ID) }
  const run = rows(steps.run)[0]
  if (!run) return { ok: false, result: errorResult(`No such run: ${route.runId}`, { errors: { runId: 'No such run' } }) }
  return { ok: true, run: fieldsOf(run), stepRows: rows(steps.steps).map(fieldsOf) }
}

export function snapshotOf(run: Row, stepRows: Row[]) {
  return snapshotFromRows(run as unknown as RunRowLike, stepRows as unknown as StepRowLike[])
}

/**
 * What a model in an agent host must be told in prose (it sees no
 * `structuredContent`): an island step is completed by the person, in this
 * chat, once the model calls `workflow.submitStep` with empty values.
 */
export function agentHostHint(runId: string, snapshot: { waitingOn: Array<{ key: string; kind: string }> }): string {
  return snapshot.waitingOn
    .map((step) =>
      step.kind === 'island' || step.kind === 'form'
        ? `\nTo let the person complete ${step.key} here, call workflow.submitStep { runId: "${runId}", step: "${step.key}", values: {} } — the step's ${step.kind} renders in this chat; do not invent its values.`
        : '',
    )
    .join('')
}

function status(route: Route, steps: StepOutputs): CallToolResult {
  const resolved = resolveRun(route, steps)
  if (!resolved.ok) return pendingOr(route, resolved.result)
  const snapshot = snapshotOf(resolved.run, resolved.stepRows)
  return textResult(snapshotText(snapshot) + agentHostHint(route.runId, snapshot), { ...snapshot })
}

function outputs(route: Route, steps: StepOutputs): CallToolResult {
  const resolved = resolveRun(route, steps)
  if (!resolved.ok) return resolved.result
  const { runId, status: runStatus, outputs: values } = snapshotOf(resolved.run, resolved.stepRows)
  const names = Object.keys(values)
  const text =
    names.length === 0
      ? `Run ${runId} is ${runStatus} and has no outputs${runStatus === 'running' ? ' yet' : ''}`
      : `Run ${runId} (${runStatus}) outputs: ${names.join(', ')}`
  return textResult(text, { runId, status: runStatus, outputs: values })
}

function runs(route: Route, steps: StepOutputs): CallToolResult {
  if (!route.isRuns) return refuse('workflow', NEED_IMPL_WORKFLOW)
  const wanted = str(route.args.status)
  const limitArg = route.args.limit
  const limit = typeof limitArg === 'number' && limitArg >= 1 ? Math.min(Math.floor(limitArg), RUNS_MAX) : RUNS_DEFAULT
  const listed = runsWithWaiting(steps.runs, steps.waiting)
    .filter((row) => typeof row.runId === 'string' && typeof row.status === 'string')
    .filter((row) => wanted === undefined || row.status === wanted)
    .sort((a, b) => (typeof b.startedAt === 'number' ? b.startedAt : 0) - (typeof a.startedAt === 'number' ? a.startedAt : 0))
    .slice(0, limit)
    .map((row) => ({
      runId: row.runId as string,
      status: row.status as string,
      startedAt: typeof row.startedAt === 'number' ? row.startedAt : 0,
      ...(typeof row.finishedAt === 'number' ? { finishedAt: row.finishedAt } : {}),
      headless: row.headless === true,
      ...(row.unattended === undefined || row.unattended === null ? {} : { unattended: row.unattended === true }),
      ...(typeof row.startedBy === 'string' ? { startedBy: row.startedBy } : {}),
      waitingOn: row.waitingOn,
    }))
  const lines = listed.map(
    (row) => `${row.runId} ${row.status} (${new Date(row.startedAt).toISOString()})${row.waitingOn.length ? ` waiting on ${row.waitingOn.join(', ')}` : ''}`,
  )
  const { impl, workflow } = route
  return textResult(
    lines.length === 0
      ? `No runs of ${impl}/${workflow}${wanted ? ` with status ${wanted}` : ''}`
      : `${lines.length} run${lines.length === 1 ? '' : 's'} of ${impl}/${workflow}:\n${lines.join('\n')}`,
    { impl, workflow, runs: listed },
  )
}

function sign(route: Route, steps: StepOutputs): CallToolResult {
  const path = str(route.args.path)
  if (path === undefined) return refuse('path', '`path` is required')
  if (!route.isSign) return refuse('path', NOT_CONFINED)
  const url = str(steps.signed?.url)
  if (url === undefined) return refuse('path', `${route.signPath}: the sign rule returned no url`)
  return textResult(`Signed ${route.signPath} for ${SIGN_EXPIRES_IN} s`, { path: route.signPath, url, expiresIn: SIGN_EXPIRES_IN })
}

/** The declared step (raw) of a step row in the run's definition snapshot, or `undefined`. */
function declaredStep(definition: unknown, job: string, stepId: string): Record<string, unknown> | undefined {
  if (!isPlainObject(definition) || !isPlainObject(definition.jobs)) return undefined
  const jobDecl = definition.jobs[job]
  if (!isPlainObject(jobDecl) || !Array.isArray(jobDecl.steps)) return undefined
  return jobDecl.steps.find((entry: unknown): entry is Record<string, unknown> => isPlainObject(entry) && entry.id === stepId)
}

/** `workflow.stepView` for a form (Phase 4, Decision 2): the fields the page evaluated when the step started waiting, straight off the row — nothing is re-evaluated here. */
function formView(route: Route, run: Row, row: Row): CallToolResult {
  if (row.status !== 'waiting') return refuse('step', `${route.key} is ${String(row.status)}, not waiting`)
  const inputs = isPlainObject(row.inputs) ? row.inputs : {}
  const fields = isPlainObject(inputs.fields) ? inputs.fields : null
  if (!fields) return refuse('step', `${route.key}: the form's evaluated fields were not recorded — complete it on the harness page`)
  const initial: Record<string, unknown> = {}
  for (const [name, decl] of Object.entries(fields)) {
    const field = isPlainObject(decl) ? decl : {}
    initial[name] = field.default === undefined ? null : field.default
  }
  const names = Object.keys(fields)
  const title = str(inputs.title) ?? String(row.step ?? route.key)
  const description = str(inputs.description)
  return textResult(`${route.key} (form) is waiting — ${names.length} field${names.length === 1 ? '' : 's'}: ${names.join(', ')}`, {
    runId: route.runId,
    step: route.key,
    impl: String(run.impl ?? ''),
    workflow: String(run.workflow ?? ''),
    kind: 'form',
    status: 'waiting',
    title,
    ...(description === undefined ? {} : { description }),
    submit: str(inputs.submit) ?? 'Submit',
    fields,
    initial,
  })
}

/** `workflow.stepView`: everything the step view needs to mount the waiting island (Decision 3). */
function stepView(route: Route, steps: StepOutputs): CallToolResult {
  const resolved = resolveRun(route, steps)
  if (!resolved.ok) return resolved.result
  if (route.key === '') return refuse('step', '`step` is required')
  const row = resolved.stepRows.find((r) => r.key === route.key)
  if (!row) return refuse('step', `No such step: ${route.key}`)
  if (row.kind === 'form') return formView(route, resolved.run, row)
  if (row.kind !== 'island') return refuse('step', `${route.key} is a ${String(row.kind)} step, not an interactive one`)
  if (row.status !== 'waiting') return refuse('step', `${route.key} is ${String(row.status)}, not waiting`)
  const plan = steps.plan
  if (!plan?.hasIsland) return refuse('step', plan?.islandError || `${route.key}: no island to show`)
  const island = steps.island
  if (island?.ok !== true || typeof island.body !== 'string') {
    return refuse('step', `${route.key}: the island file could not be fetched${island?.status ? ` (${island.status})` : ''}`)
  }
  const decl = declaredStep(resolved.run.definition, String(row.job ?? ''), String(row.step ?? ''))
  const withDecl = decl && isPlainObject(decl.with) ? decl.with : {}
  const inputs = isPlainObject(row.inputs) ? row.inputs : {}
  const src = typeof withDecl.src === 'string' ? withDecl.src : ''
  return textResult(`${route.key} (island) is waiting — ${Object.keys(inputs).length} arguments`, {
    runId: route.runId,
    step: route.key,
    impl: String(resolved.run.impl ?? ''),
    workflow: String(resolved.run.workflow ?? ''),
    kind: 'island',
    status: 'waiting',
    src,
    arguments: inputs,
    ...(decl && isPlainObject(decl.outputs) ? { outputs: decl.outputs } : {}),
    html: island.body,
  })
}

/** `workflow.pipeline`: the island's own pipeline, fenced to the run's implementation (Decision 4). */
function pipeline(route: Route, steps: StepOutputs): CallToolResult {
  const resolved = resolveRun(route, steps)
  if (!resolved.ok) return resolved.result
  const plan = steps.plan
  if (!plan) return refuse('name', 'the plan step did not run')
  if (plan.pipelineError !== '') return refuse('name', plan.pipelineError)
  const answer = plan.isPipelineGet ? steps.pipelineGet : steps.pipelinePost
  if (!answer) return refuse('name', `${plan.pipelineUrl}: the pipeline step did not run`)
  const status = typeof answer.status === 'number' ? answer.status : answer.ok ? 200 : 500
  if (answer.ok !== true) return pipelineError(plan.pipelineUrl, status, answer.body)
  return pipelineResult(answer.body)
}

// ---------------------------------------------------------------------------
// Driven runs (ADR-0006): `start`, `resume` and a re-dispatching `submitStep`
//
// The endpoint dispatches; it does not drive. All three end in the same place —
// the harness's own `run/drive` rule, posted a body by the `drive` step — and
// differ only in what they say about it. What that rule answers is the whole
// outcome: 202 with a receipt, 400 with a code from its own table, or anything
// else, which is a dispatch that did not happen.
// ---------------------------------------------------------------------------

/**
 * A run that has been dispatched but whose job has not written a row yet: the
 * one snapshot this harness reports with no rows to derive it from. It is the
 * honest answer to "what is run X doing" in the minute between the dispatch and
 * the first row — the alternative, `No such run`, reads as failure.
 */
function pendingSnapshot(runId: string): RunSnapshot {
  return { runId, status: 'pending', currentSteps: [], outputs: {}, steps: {}, waitingOn: [] }
}

/**
 * `workflow.status` for a run with no row: `pending` while the id was minted
 * within the window (only this endpoint mints ids, and only for a dispatch),
 * the caller's own refusal after it — a driver that never started must
 * eventually be reported as no run, not as one forever about to begin.
 */
function pendingOr(route: Route, refusal: CallToolResult): CallToolResult {
  const minted = runIdTime(route.runId)
  if (minted === null || Math.abs(Date.now() - minted) > PENDING_WINDOW_MS) return refusal
  const snapshot = pendingSnapshot(route.runId)
  return textResult(`${snapshotText(snapshot)}. Poll again.`, { ...snapshot })
}

/** What the `drive` step's answer means: the receipt, the rule's own refusal by code, or a dispatch that did not happen. */
function driveOutcome(steps: StepOutputs, dispatched: () => CallToolResult): CallToolResult {
  const drive = steps.drive
  const status = typeof drive?.status === 'number' ? drive.status : 0
  if (status === 202) return dispatched()
  const body = bodyObject(drive?.body) ?? {}
  if (status === 400) {
    const code = typeof body.code === 'string' ? body.code : 'BAD_REQUEST'
    const message = typeof body.message === 'string' ? body.message : 'the drive rule refused this dispatch'
    return errorResult(`${code}: ${message}`, { errors: { drive: code } })
  }
  const said = status === 0 ? 'did not answer' : `answered ${status}`
  return errorResult(`DISPATCH_FAILED: the drive rule ${said} — nothing was dispatched; run it on the harness page instead`, {
    errors: { drive: 'DISPATCH_FAILED' },
  })
}

/** Where a start's own refusal belongs in `errors` (spec 07 keys it by what failed): the workflow, the tool, or the inputs. */
function driveErrorKey(message: string): string {
  if (message === REFUSALS.noWorkflow) return 'workflow'
  return message.indexOf('NO_DRIVER') === 0 ? 'tool' : 'inputs'
}

/** `workflow.start`: the implementation's driver is dispatched, and the caller is handed the id it can poll. */
function start(route: Route, steps: StepOutputs): CallToolResult {
  if (route.impl === '') return refuse('impl', '`impl` is required')
  if (route.workflow === '') return refuse('workflow', '`workflow` is required')
  if (!route.isStart) return refuse('discovery', REFUSALS.discovery)
  const plan = steps.plan
  if (!plan) return refuse('tool', 'the plan step did not run')
  if (plan.driveError !== '') return refuse(driveErrorKey(plan.driveError), plan.driveError)
  const { runId } = plan
  return driveOutcome(steps, () =>
    textResult(
      `Dispatched run ${runId} of ${route.impl}/${route.workflow} to its driver; pending — the row appears when the job starts (about a minute). Poll workflow.status; when it reports waiting, complete the step here with workflow.submitStep.`,
      { ...pendingSnapshot(runId), pending: true },
    ),
  )
}

/** `workflow.resume`: a driver takes over a run nothing is driving — the endpoint's answer to an abandoned lease. */
function resume(route: Route, steps: StepOutputs): CallToolResult {
  const resolved = resolveRun(route, steps)
  if (!resolved.ok) return resolved.result
  const plan = steps.plan
  if (!plan) return refuse('tool', 'the plan step did not run')
  if (plan.driveError !== '') return refuse('runId', plan.driveError)
  const snapshot = snapshotOf(resolved.run, resolved.stepRows)
  return driveOutcome(steps, () =>
    textResult(
      `Dispatched a driver to resume ${route.runId}; it takes the run over when the job starts (about a minute). Poll workflow.status; when it reports waiting, complete the step here with workflow.submitStep.`,
      { ...snapshot, dispatched: true },
    ),
  )
}

/**
 * `workflow.submitStep`'s verdict, plus what became of the run it unblocked.
 * The write is the answer and stands on its own — a dispatch that failed does
 * not turn an accepted submit into an error — but a model that is not told has
 * no way to know whether anything is carrying the run forward, so the note goes
 * in the text (all a text-only host shows) as well as in `dispatched`.
 */
function withDriveNote(verdict: CallToolResult, steps: StepOutputs): CallToolResult {
  if (steps.plan?.isDrive !== true) return verdict
  const drive = steps.drive
  const dispatched = drive?.status === 202
  const body = bodyObject(drive?.body) ?? {}
  const code = typeof body.code === 'string' ? body.code : 'DISPATCH_FAILED'
  const note = dispatched ? '; a driver was dispatched to continue the run' : `; not dispatched (${code}): resume it on the harness page`
  return {
    ...verdict,
    content: verdict.content.map((entry, i) => (i === 0 ? { ...entry, text: `${entry.text}${note}` } : entry)),
    structuredContent: { ...verdict.structuredContent, dispatched },
  }
}

function notServed(tool: string): CallToolResult {
  const message =
    tool === 'workflow.await'
      ? 'workflow.await is not served by the MCP endpoint — a stateless POST cannot wait; poll workflow.status'
      : `${tool} is not served by the MCP endpoint: runs are driven on the harness page — by a person, or by an agent through the page’s own workflow.* tools (WebMCP). Ask the person to do that on the harness page; then watch the run with workflow.status and complete its interactive steps here with workflow.submitStep.`
  return refuse('tool', message)
}

function callTool(route: Route, steps: StepOutputs): CallToolResult {
  const tool = route.tool
  if (tool === '') return refuse('tool', 'A tool `name` is required')
  switch (tool) {
    case 'workflow.list':
      return list(route, steps)
    case 'workflow.describe':
      return describe(route, steps)
    case 'workflow.status':
      return status(route, steps)
    case 'workflow.outputs':
      return outputs(route, steps)
    case 'workflow.runs':
      return runs(route, steps)
    case 'workflow.sign':
      return sign(route, steps)
    case 'workflow.start':
      return start(route, steps)
    case 'workflow.resume':
      return resume(route, steps)
    case 'workflow.await':
      return notServed(tool)
    default:
      break
  }
  if (NOT_SERVED.has(tool)) return notServed(tool)
  if (tool === 'workflow.stepView') return stepView(route, steps)
  if (tool === 'workflow.pipeline') return pipeline(route, steps)
  if (WRITE_TOOLS.has(tool) || isHostTool(tool)) {
    const verdict = steps.merge?.result
    if (!verdict) return refuse('tool', `${tool} is not served by this build of the MCP endpoint`)
    if (steps.merge?.update === true && !stepUpdated(steps.update)) {
      return refuse('step', `${route.key}: the step row could not be written`)
    }
    // Only `submitStep` re-dispatches: `submit` and `annotate` are the island's
    // own bridge verbs, called from a page that is already driving the run.
    return tool === 'workflow.submitStep' ? withDriveNote(verdict, steps) : verdict
  }
  if (toolByName(tool)) return notServed(tool)
  return errorResult(`No such tool: ${tool}`, { errors: { tool: 'No such tool' } })
}

// ---------------------------------------------------------------------------
// The resources-list rule: what the app enumerates — every discovered island.
// CE's mcp_handler adds the step view (a static resource) and every `_meta.ui`.
// ---------------------------------------------------------------------------

export function resourcesList(steps: StepOutputs): Array<Record<string, unknown>> {
  const resources: Array<Record<string, unknown>> = []
  for (const impl of discovered(steps)) {
    for (const island of impl.islands) {
      resources.push({
        uri: `ui://bffless/${impl.alias}/${island}`,
        name: `${impl.alias}: ${island}`,
        description: `An island of the ${impl.name} implementation, served unchanged (spec 04).`,
        mimeType: RESOURCE_MIME,
      })
    }
  }
  return resources
}

// ---------------------------------------------------------------------------

export function handler(data: { request?: FnRequest; steps: StepOutputs; deployment?: FnDeployment }): Reply {
  const steps = data.steps ?? {}
  const route = steps.route
  const json = (value: unknown): Reply => ({ json: JSON.stringify(value) })
  if (!route) return json(errorResult('The route step did not run', { errors: { tool: 'The route step did not run' } }))
  switch (route.kind) {
    case 'resourcesList':
      return json(resourcesList(steps))
    case 'toolsCall':
      return json(callTool(route, steps))
    default:
      return json(errorResult(route.message || 'Not a tool rule', { errors: { tool: route.message || 'Not a tool rule' } }))
  }
}
