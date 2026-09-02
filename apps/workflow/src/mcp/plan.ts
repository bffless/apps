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
 * - `resources/read ui://bffless/<impl>/<rest>`: `resolveSrc`'s fence — the
 *   very check the harness page applies to an island's `src` — decides whether
 *   `/w/<impl>/<rest>` is fetched at all.
 * - `workflow.stepView`: the waiting step's `with.src` from the run's
 *   definition snapshot, through the same fence, against the **run's** impl.
 * - `workflow.pipeline`: `resolveToolName` against the run's impl — the
 *   own-implementation fence exactly as `IslandHost` applies it (04) — names
 *   the sibling rule the `pipelinePost`/`pipelineGet` step calls.
 */
import { resolveSrc, resolveToolName } from '../lib/runner/adapters/island'
import { workflowId } from './ids'
import { fieldsOf, rows } from './rows'
import { LIST_FANOUT, type FnDeployment, type FnRequest, type Route } from './route'

export interface Plan {
  has1: boolean
  has2: boolean
  has3: boolean
  url1: string
  url2: string
  url3: string
  /** The implementation aliases whose index is fetched, in order. */
  aliases: string[]
  /** Implementation aliases past the fan-out cap, not listed. */
  skipped: string[]
  hasYaml: boolean
  yamlUrl: string
  /** The `workflows[]` entry `describe` asked for, as the index lists it. */
  listing: Record<string, unknown> | null
  hasIsland: boolean
  islandUrl: string
  /** Why no island is fetched (a fenced-out `src`, no such step, …). */
  islandError: string
  isPipelinePost: boolean
  isPipelineGet: boolean
  pipelineUrl: string
  pipelineBody: Record<string, unknown>
  pipelineError: string
}

export interface PlanSteps {
  route: Route
  aliases?: { ok?: boolean; status?: number; body?: unknown }
  index?: { ok?: boolean; status?: number; body?: unknown }
  run?: unknown
  steps?: unknown
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
    aliases: [],
    skipped: [],
    hasYaml: false,
    yamlUrl: '',
    listing: null,
    hasIsland: false,
    islandUrl: '',
    islandError: '',
    isPipelinePost: false,
    isPipelineGet: false,
    pipelineUrl: '',
    pipelineBody: {},
    pipelineError: '',
  }
  // A pipeline always runs `route` first; a bare smoke call answers the empty plan.
  if (!route) return plan
  const indexUrlOf = (alias: string) => `${route.appOrigin}/w/${alias}/.bffless/workflows/index.json`

  if (route.isList && route.appOrigin !== '') {
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
    Object.assign(plan, { has1: url1 !== '', url1, has2: url2 !== '', url2, has3: url3 !== '', url3 })
  }

  if (route.isDescribe) {
    const index = data.steps.index
    const body = index?.ok === true && isPlainObject(index.body) ? index.body : null
    const workflows = body && Array.isArray(body.workflows) ? body.workflows : []
    const listing = workflows.find(
      (entry: unknown): entry is Record<string, unknown> =>
        isPlainObject(entry) && typeof entry.file === 'string' && workflowId(entry.file) === route.workflow,
    )
    if (listing && route.appOrigin !== '') {
      plan.listing = listing
      plan.hasYaml = true
      plan.yamlUrl = `${route.appOrigin}/w/${route.impl}/.bffless/workflows/${listing.file as string}`
    }
  }

  if (route.isIslandUri) {
    try {
      const url = resolveSrc(route.impl, route.rest)
      if (route.appOrigin !== '') {
        plan.hasIsland = true
        plan.islandUrl = `${route.appOrigin}${url}`
      }
    } catch (err) {
      plan.islandError = err instanceof Error ? err.message : String(err)
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
          if (route.appOrigin !== '') {
            plan.hasIsland = true
            plan.islandUrl = `${route.appOrigin}${url}`
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
      else if (route.appOrigin === '') plan.pipelineError = 'the request named no host'
      else if (target.method === 'GET') {
        plan.isPipelineGet = true
        plan.pipelineUrl = `${route.appOrigin}${target.url}${queryOf(args)}`
      } else {
        plan.isPipelinePost = true
        plan.pipelineUrl = `${route.appOrigin}${target.url}`
        plan.pipelineBody = args
      }
    }
  }

  return plan
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
