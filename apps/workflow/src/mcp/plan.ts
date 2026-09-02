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
 */
import { resolveSrc } from '../lib/runner/adapters/island'
import { workflowId } from './ids'
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

  return plan
}
