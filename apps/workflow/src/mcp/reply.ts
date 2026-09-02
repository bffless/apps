/**
 * `reply` — the MCP endpoint rule's last function step (spec 10, D22; Phase 2
 * plan, Task 4): the JSON-RPC answer, assembled from what the gated steps
 * fetched or queried. Every `tools/call` answer is a catalog `CallToolResult`
 * built with the catalog's own builders (D19), worded as the harness page
 * words it (`src/agent/executors.ts` is the reference; the parity tests hold
 * the two together).
 *
 * The body is pre-serialized here and rendered by the `respond` step with
 * `{{{steps.reply.json}}}` — whoami's quote-safe shape (apps#381).
 */
import {
  CATALOG,
  errorResult,
  snapshotFromRows,
  snapshotText,
  textResult,
  toolByName,
  type CallToolResult,
  type RunRowLike,
  type StepRowLike,
} from '@bffless/workflow-agent-tools'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { parse } from 'yaml'
import { describeWorkflow } from '../lib/describe'
import { originOf, uiMeta } from './csp'
import { RESOURCE_MIME, SERVER_VERSION, STEP_VIEW_URI, isHostTool, listedTools } from './hostTools'
import { workflowId } from './ids'
import { ERR, errorResponse, negotiateVersion, okResponse, type Id } from './jsonrpc'
import type { Plan } from './plan'
import { NEED_IMPL_WORKFLOW, NEED_RUN_ID, NOT_CONFINED, REFUSALS } from './refusals'
import { fieldsOf, rows, runsWithWaiting, type Row } from './rows'
import type { FnDeployment, FnRequest, Route } from './route'

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
  identity?: HttpStep
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
  stepView?: HttpStep
  probe?: { url?: string }
  signed?: { url?: string }
  /** Task 10: the write branch's verdict. */
  merge?: { update?: boolean; result?: CallToolResult }
  update?: unknown
  pipelinePost?: HttpStep
  pipelineGet?: HttpStep
}

export interface Reply {
  json: string
  status: number
}

const SERVER_NAME = 'bffless-workflow'
const NOT_SERVED = new Set(['workflow.start', 'workflow.cancel', 'workflow.resume'])
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

function jsonBody(step: HttpStep | undefined): Record<string, unknown> | null {
  if (step?.ok !== true) return null
  const body = step.body
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

/** The page's `describe` executor's sentence, verbatim (`src/agent/executors.ts`). */
export function describeText(described: ReturnType<typeof describeWorkflow>, impl: string, workflow: string): string {
  const interactive = described.jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.kind === 'island' || step.kind === 'form')
      .map((step) => `${job.id}/${step.id} (${step.kind}${step.headless ? `, headless: ${step.headless}` : ', needs a person'})`),
  )
  return `${described.name} (${impl}/${workflow}): ${Object.keys(described.inputs).length} inputs, ${described.jobs.length} jobs, ${Object.keys(described.outputs).length} outputs${interactive.length ? `; interactive steps: ${interactive.join(', ')}` : '; no interactive steps'}${described.headlessSafe ? '; headless-safe' : ''}`
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
  return textResult(describeText(described, route.impl, route.workflow), { ...described })
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

function status(route: Route, steps: StepOutputs): CallToolResult {
  const resolved = resolveRun(route, steps)
  if (!resolved.ok) return resolved.result
  const snapshot = snapshotOf(resolved.run, resolved.stepRows)
  return textResult(snapshotText(snapshot), { ...snapshot })
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

function notServed(tool: string): CallToolResult {
  const message =
    tool === 'workflow.await'
      ? 'workflow.await is not served by the MCP endpoint — a stateless POST cannot wait; poll workflow.status'
      : `${tool} is not served by the MCP endpoint yet (Phase 4 adds the run view that drives runs)`
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
    case 'workflow.await':
      return notServed(tool)
    default:
      break
  }
  if (NOT_SERVED.has(tool)) return notServed(tool)
  if (WRITE_TOOLS.has(tool) || isHostTool(tool)) {
    const verdict = steps.merge?.result
    if (verdict) return verdict
    return refuse('tool', `${tool} is not served by this build of the MCP endpoint`)
  }
  if (toolByName(tool)) return notServed(tool)
  return errorResult(`No such tool: ${tool}`, { errors: { tool: 'No such tool' } })
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

function storageOrigin(steps: StepOutputs): string {
  return originOf(steps.probe?.url)
}

function resourcesList(route: Route, steps: StepOutputs): unknown {
  const meta = uiMeta(route.appOrigin, storageOrigin(steps))
  const resources: Array<Record<string, unknown>> = [
    { uri: STEP_VIEW_URI, name: 'Workflow step view', description: 'Mounts a waiting island step of a run (spec 10).', mimeType: RESOURCE_MIME, _meta: meta },
  ]
  for (const impl of discovered(steps)) {
    for (const island of impl.islands) {
      resources.push({
        uri: `ui://bffless/${impl.alias}/${island}`,
        name: `${impl.alias}: ${island}`,
        description: `An island of the ${impl.name} implementation, served unchanged (spec 04).`,
        mimeType: RESOURCE_MIME,
        _meta: meta,
      })
    }
  }
  return { resources }
}

function resourcesRead(route: Route, steps: StepOutputs, id: Id): unknown {
  const source = route.isStepView ? steps.stepView : route.isIslandUri ? steps.island : undefined
  if (route.isIslandUri && steps.plan && !steps.plan.hasIsland) {
    return errorResponse(id, ERR.RESOURCE_NOT_FOUND, `Resource not found: ${route.uri} (${steps.plan.islandError || 'not an island of that implementation'})`)
  }
  if (!source || source.ok !== true || typeof source.body !== 'string') {
    return errorResponse(id, ERR.RESOURCE_NOT_FOUND, `Resource not found: ${route.uri}`)
  }
  return okResponse(id, {
    contents: [{ uri: route.uri, mimeType: RESOURCE_MIME, text: source.body, _meta: uiMeta(route.appOrigin, storageOrigin(steps)) }],
  })
}

// ---------------------------------------------------------------------------

export function handler(data: { request?: FnRequest; steps: StepOutputs; deployment?: FnDeployment }): Reply {
  const steps = data.steps ?? {}
  const route = steps.route
  const json = (value: unknown): Reply => ({ json: JSON.stringify(value), status: 200 })
  if (!route) return json(errorResponse(null, ERR.INTERNAL, 'The route step did not run'))
  const id = route.id

  switch (route.kind) {
    case 'invalid':
      return json(errorResponse(id, ERR.INVALID_REQUEST, route.message))
    case 'notification':
      return { json: '', status: 202 }
    case 'initialize':
      return json(
        okResponse(id, {
          protocolVersion: negotiateVersion(route.params.protocolVersion),
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: `The BFFless Workflow harness: ${CATALOG.length} workflow.* tools to list, describe and watch runs and complete a waiting island step. Pass runId to every run-scoped tool.`,
        }),
      )
    case 'ping':
      return json(okResponse(id, {}))
    default:
      break
  }

  if (steps.identity?.ok !== true) {
    return json(
      errorResponse(id, ERR.NOT_ENABLED, 'MCP endpoint is not enabled on this install: no WORKFLOW_MCP_KEY service identity', {
        status: steps.identity?.status ?? null,
      }),
    )
  }

  switch (route.kind) {
    case 'toolsList':
      return json(okResponse(id, { tools: listedTools() }))
    case 'toolsCall':
      return json(okResponse(id, callTool(route, steps)))
    case 'resourcesList':
      return json(okResponse(id, resourcesList(route, steps)))
    case 'resourcesRead':
      return json(resourcesRead(route, steps, id))
    default:
      return json(errorResponse(id, ERR.METHOD_NOT_FOUND, `Method not found: ${route.method}`))
  }
}
