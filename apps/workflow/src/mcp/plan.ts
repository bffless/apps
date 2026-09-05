/**
 * `plan` — the MCP endpoint rule's second function step (Phase 2 plan, Task 3):
 * the URLs only an earlier step's answer can supply. It runs after `aliases`,
 * `index`, `run` and `steps`, and before the fan-out fetches (`index1..3`),
 * `yaml`, and — from Task 11 — `island` and the pipeline call.
 *
 * - `workflow.list` / `resources/list` without `impl`: the first `LIST_FANOUT`
 *   implementation aliases the harness's alias relay listed (the harness's own
 *   alias skipped; previews included — 06 lists them with a badge). The step
 *   list is static, so the cap is real: anything past it is reported as
 *   `skipped`, the prototype limit the generic `mcp_handler` (story 8) removes.
 * - `workflow.describe`: the YAML named by the index's `workflows[].file` for
 *   the requested workflow — `interactive.workflow.yaml`, not a guessed
 *   `<workflow>.yaml`.
 * - `workflow.stepView`: the waiting step's `with.src` from the run's
 *   definition snapshot, through the same fence, against the **run's** impl.
 * - `workflow.pipeline`: `resolveToolName` against the run's impl — the
 *   own-implementation fence exactly as `IslandHost` applies it (04) — names
 *   the sibling rule the `pipelinePost`/`pipelineGet` step calls.
 */
import { resolveSrc, resolveToolName } from '../lib/runner/adapters/island'
import { mintRunId, workflowId } from './ids'
import { REFUSALS } from './refusals'
import { fieldsOf, rows, stepUpdated } from './rows'
import { LIST_FANOUT, type FnDeployment, type FnRequest, type Route } from './route'

export interface Plan {
  has1: boolean
  has2: boolean
  has3: boolean
  url1: string
  url2: string
  url3: string
  /** The public-relative paths of url1..3 (CE matches `x-original-uri`). */
  path1: string
  path2: string
  path3: string
  /** The implementation aliases whose index is fetched, in order. */
  aliases: string[]
  /** Implementation aliases past the fan-out cap, not listed. */
  skipped: string[]
  hasYaml: boolean
  yamlUrl: string
  yamlPath: string
  /** The `workflows[]` entry `describe` asked for, as the index lists it. */
  listing: Record<string, unknown> | null
  hasIsland: boolean
  islandUrl: string
  islandPath: string
  /** Why no island is fetched (a fenced-out `src`, no such step, …). */
  islandError: string
  isPipelinePost: boolean
  isPipelineGet: boolean
  pipelineUrl: string
  pipelinePath: string
  pipelineBody: Record<string, unknown>
  pipelineError: string
  // --- driven runs (ADR-0006) ---------------------------------------------
  /** Gate of the `drive` step: post `driveBody` to the harness's own `run/drive` rule. */
  isDrive: boolean
  /** `route.driveUrl`/`drivePath`, copied so the `drive` step reads one source. */
  driveUrl: string
  drivePath: string
  /** The drive rule's body, exactly as it reads it: `{ id, mode }` plus, for a `run`, what to run. */
  driveBody: Record<string, unknown>
  /** Why no dispatch is planned — the caller's refusal, said once, here. */
  driveError: string
  /** The run the dispatch is about: minted for a `start`, the caller's for a `resume`. */
  runId: string
}

export interface PlanSteps {
  route: Route
  aliases?: { ok?: boolean; status?: number; body?: unknown }
  index?: { ok?: boolean; status?: number; body?: unknown }
  run?: unknown
  steps?: unknown
  /** `workflow.submitStep` only: what the `data_update` step answered. Its rule runs `plan` AFTER the write, because only a landed write re-dispatches the driver (ADR-0006). */
  update?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The alias names a `GET /api/workflow/aliases` relay answered (`{ data: [...] }` or a bare list). */
export function aliasNames(body: unknown): string[] {
  const list = Array.isArray(body) ? body : isPlainObject(body) && Array.isArray(body.data) ? body.data : []
  return list
    .map((entry: unknown) => (isPlainObject(entry) && typeof entry.alias === 'string' ? entry.alias : ''))
    .filter((alias: string) => alias !== '')
}

export function handler(data: { steps: PlanSteps; request?: FnRequest; deployment?: FnDeployment }): Plan {
  const route: Route | undefined = data.steps?.route
  const harnessAlias = typeof data.deployment?.alias === 'string' ? data.deployment.alias : 'workflow'
  const plan: Plan = {
    has1: false,
    has2: false,
    has3: false,
    url1: '',
    url2: '',
    url3: '',
    path1: '',
    path2: '',
    path3: '',
    aliases: [],
    skipped: [],
    hasYaml: false,
    yamlUrl: '',
    yamlPath: '',
    listing: null,
    hasIsland: false,
    islandUrl: '',
    islandPath: '',
    islandError: '',
    isPipelinePost: false,
    isPipelineGet: false,
    pipelineUrl: '',
    pipelinePath: '',
    pipelineBody: {},
    pipelineError: '',
    isDrive: false,
    driveUrl: '',
    drivePath: '',
    driveBody: {},
    driveError: '',
    runId: '',
  }
  // A pipeline always runs `route` first; a bare smoke call answers the empty plan.
  if (!route) return plan
  plan.driveUrl = route.driveUrl
  plan.drivePath = route.drivePath
  const base = route.siblingBase
  const indexPathOf = (alias: string) => `/w/${alias}/.bffless/workflows/index.json`
  const indexUrlOf = (alias: string) => `${base}${indexPathOf(alias)}`

  if (route.isList && base !== '') {
    let wanted: string[]
    if (route.impl !== '') {
      wanted = [route.impl]
    } else {
      const aliases = data.steps.aliases
      wanted = aliases?.ok === true ? aliasNames(aliases.body).filter((alias) => alias !== harnessAlias) : []
    }
    plan.aliases = wanted.slice(0, LIST_FANOUT)
    plan.skipped = wanted.slice(LIST_FANOUT)
    const [url1 = '', url2 = '', url3 = ''] = plan.aliases.map(indexUrlOf)
    const [path1 = '', path2 = '', path3 = ''] = plan.aliases.map(indexPathOf)
    Object.assign(plan, { has1: url1 !== '', url1, path1, has2: url2 !== '', url2, path2, has3: url3 !== '', url3, path3 })
  }

  if (route.isDescribe) {
    const listing = listedWorkflow(indexJson(data.steps.index), route.workflow)
    if (listing && base !== '') {
      plan.listing = listing
      plan.hasYaml = true
      plan.yamlPath = `/w/${route.impl}/.bffless/workflows/${listing.file as string}`
      plan.yamlUrl = `${base}${plan.yamlPath}`
    }
  }

  if (route.tool === 'workflow.stepView' || route.tool === 'workflow.pipeline') {
    const runRow = rows(data.steps.run)[0]
    const run = runRow ? fieldsOf(runRow) : null
    const impl = run && typeof run.impl === 'string' ? run.impl : ''
    if (!run || impl === '') {
      const missing = `No such run: ${route.runId}`
      plan.islandError = missing
      plan.pipelineError = missing
      return plan
    }
    if (route.tool === 'workflow.stepView') {
      const row = rows(data.steps.steps).map(fieldsOf).find((r) => r.key === route.key)
      const src = row ? declaredSrc(run.definition, String(row.job ?? ''), String(row.step ?? '')) : ''
      if (!row) plan.islandError = `No such step: ${route.key}`
      else if (src === '') plan.islandError = `${route.key}: the run's definition snapshot declares no island src`
      else {
        try {
          const url = resolveSrc(impl, src)
          if (base !== '') {
            plan.hasIsland = true
            plan.islandPath = url
            plan.islandUrl = `${base}${url}`
          }
        } catch (err) {
          plan.islandError = err instanceof Error ? err.message : String(err)
        }
      }
    } else {
      const name = typeof route.args.name === 'string' ? route.args.name : ''
      const method = route.args.method === 'GET' ? 'GET' : 'POST'
      const target = resolveToolName(impl, name, { bffless: { method } })
      const args = isPlainObject(route.args.arguments) ? route.args.arguments : {}
      if (target.kind === 'rejected') plan.pipelineError = target.reason
      else if (target.kind === 'host') plan.pipelineError = `tool "${name}": workflow.${target.tool} is a host tool — call it directly`
      else if (base === '') plan.pipelineError = 'the request named no host'
      else if (target.method === 'GET') {
        plan.isPipelineGet = true
        plan.pipelinePath = `${target.url}${queryOf(args)}`
        plan.pipelineUrl = `${base}${plan.pipelinePath}`
      } else {
        plan.isPipelinePost = true
        plan.pipelinePath = target.url
        plan.pipelineUrl = `${base}${target.url}`
        plan.pipelineBody = args
      }
    }
  }

  // --- driven runs (ADR-0006): what the `drive` step posts, and why it may not
  //
  // The three tools that dispatch differ only in what they must know first: a
  // `start` needs the implementation's index (the workflow it lists, the driver
  // it publishes), a `resume` needs the run row, a `submitStep` needs its own
  // write to have landed. Each refusal is decided once, here, and said once by
  // `reply` — the drive rule judges the request again on arrival, but a caller
  // should never be sent a dispatch that is already known to be pointless.
  if (route.isStart) {
    const index = indexJson(data.steps.index)
    const driver = index !== null && isPlainObject(index.driver) ? index.driver : {}
    const repo = typeof driver.repo === 'string' ? driver.repo : ''
    if (!listedWorkflow(index, route.workflow)) plan.driveError = REFUSALS.noWorkflow
    else if (repo === '') plan.driveError = NO_DRIVER
    else if (!isPlainObject(route.args.inputs)) plan.driveError = '`inputs` must be an object'
    else {
      // The id is minted here, not by the driver: it is what `workflow.start`
      // hands back before any row exists, so the caller can poll from the
      // moment it is told the run was dispatched.
      plan.runId = mintRunId(Date.now())
      plan.isDrive = plan.driveUrl !== ''
      plan.driveBody = { id: plan.runId, mode: 'run', impl: route.impl, workflow: route.workflow, inputs: route.args.inputs }
    }
  } else if (route.isResume) {
    const runRow = rows(data.steps.run)[0]
    const run = runRow ? fieldsOf(runRow) : null
    const status = run === null ? '' : String(run.status)
    if (run === null) plan.driveError = `No such run: ${route.runId}`
    else if (status !== 'running') plan.driveError = `Run ${route.runId} is ${status}; only a running run can be resumed`
    else {
      plan.runId = route.runId
      plan.isDrive = plan.driveUrl !== ''
      plan.driveBody = { id: route.runId, mode: 'resume' }
    }
  } else if (route.tool === 'workflow.submitStep' && stepUpdated(data.steps.update)) {
    // The write landed on a step the run was parked on, so the run can move
    // again — and nothing is on the page to move it. A dispatch here is what
    // makes an agent-completed step continue a driven run; the drive rule
    // refuses it harmlessly (LEASE_LIVE) when a person does have the page open.
    plan.runId = route.runId
    plan.isDrive = plan.driveUrl !== ''
    plan.driveBody = { id: route.runId, mode: 'resume' }
  }

  return plan
}

/** The `NO_DRIVER` refusal in the vocabulary a model reads — the drive rule's own code, plus where the run can be started instead. */
const NO_DRIVER = 'NO_DRIVER: this implementation publishes no driver — start it on the harness page'

/** An implementation's `index.json` as an object, however the step answered it (CE parses JSON; a sibling that did not say JSON answers text). */
function indexJson(step: PlanSteps['index']): Record<string, unknown> | null {
  if (step?.ok !== true) return null
  if (isPlainObject(step.body)) return step.body
  if (typeof step.body === 'string') {
    try {
      const parsed: unknown = JSON.parse(step.body)
      return isPlainObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/** The `workflows[]` entry of an index whose file names this workflow — the id comes off the file name, never a guess (06). */
function listedWorkflow(index: Record<string, unknown> | null, workflow: string): Record<string, unknown> | null {
  const workflows = index !== null && Array.isArray(index.workflows) ? index.workflows : []
  const listing = workflows.find(
    (entry: unknown): entry is Record<string, unknown> => isPlainObject(entry) && typeof entry.file === 'string' && workflowId(entry.file) === workflow,
  )
  return listing ?? null
}

/** The `with.src` of (job, stepId) in a raw definition snapshot, or `''`. */
function declaredSrc(definition: unknown, job: string, stepId: string): string {
  if (!isPlainObject(definition) || !isPlainObject(definition.jobs)) return ''
  const jobDecl = definition.jobs[job]
  if (!isPlainObject(jobDecl) || !Array.isArray(jobDecl.steps)) return ''
  const step = jobDecl.steps.find((entry: unknown): entry is Record<string, unknown> => isPlainObject(entry) && entry.id === stepId)
  const withDecl = step && isPlainObject(step.with) ? step.with : undefined
  return withDecl && typeof withDecl.src === 'string' ? withDecl.src : ''
}

/** `?a=1&b=x` for a GET's arguments — a pipeline's query string, `''` when there are none. */
export function queryOf(args: Record<string, unknown>): string {
  const pairs = Object.entries(args).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value))}`)
  return pairs.length ? `?${pairs.join('&')}` : ''
}
