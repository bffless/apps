/**
 * `route` — the first function step of every MCP tool rule (spec 10, D22 GA;
 * Phase 3 plan, Task B1). The endpoint itself is CE's `mcp_handler`; each tool
 * is a sibling rule it invokes in-process as the caller, so this function no
 * longer parses JSON-RPC: the tool is the rule's own path
 * (`/api/workflow/mcp-tools/<name>`), the arguments are the request body, and
 * out come the same condition flags and derived URLs the pipeline's *static*
 * steps read (CE step conditions are simple paths, never compound — so every
 * gate is a flag computed here, and every URL a `http_request` /
 * `signed_url` step reads as an expression).
 *
 * Nothing here does I/O: a function_handler cannot. It plans; the pipeline
 * executes; `reply` assembles. What needs an earlier step's answer (the index
 * file to fetch a workflow's YAML from, the island a waiting step names) is
 * `plan`'s job, one step later.
 */
import { canonicalToolName } from '@bffless/workflow-agent-tools'

export const LIST_FANOUT = 3

/**
 * CE's own API, reached in-process — the same target the harness's
 * `/api/workflow/aliases` relay rule and every `/w/<impl>/*` forwarder use
 * (spec 06, ADR-0001 amendment). The caller's own credential (cookie or Bearer
 * app token) is forwarded by the `http_request` step (`forwardAuth`).
 */
export const CE_BACKEND = 'http://localhost:3000'

/** `request` as CE's function_handler hands it (`function.handler.ts`). */
export interface FnRequest {
  body: unknown
  query?: unknown
  headers: Record<string, string | string[] | undefined>
  method: string
  path: string
}

/** `deployment` as CE hands it: the **serving project** (`owner/repo`) and alias (apps#363). */
export interface FnDeployment {
  owner?: string
  repo?: string
  commitSha?: string
  alias?: string
}

/** `toolsCall` — a tool rule; `resourcesList` — the resources-list rule; `stepView` — the step-view resource rule; `invalid` — a path this bundle does not know. */
export type RouteKind = 'toolsCall' | 'resourcesList' | 'stepView' | 'invalid'

export interface Route {
  kind: RouteKind
  /** `invalid`: why. */
  message: string
  /** `toolsCall`: the dot-canonical tool name; `''` otherwise. */
  tool: string
  args: Record<string, unknown>

  // --- one flag per gated step -------------------------------------------
  /** `list` / the resources list without `impl` → `steps.aliases` (CE's alias API). */
  isAliases: boolean
  /** Read the run row + its step rows (`steps.run`, `steps.steps`). */
  needsRun: boolean
  /** `workflow.runs` with impl + workflow → `steps.runs` + `steps.waiting`. */
  isRuns: boolean
  /** Discovery: `steps.aliases` then `plan` then `index1..3`. */
  isList: boolean
  /** `workflow.describe` → `steps.index` (then `plan` names the YAML). */
  isDescribe: boolean
  /** The step-view resource rule → `steps.stepView` fetches `/step.html` in-process. */
  isStepView: boolean
  /** `workflow.sign` with a confined path → `steps.signed`. */
  isSign: boolean

  // --- derived values the gated steps read ---------------------------------
  runId: string
  key: string
  impl: string
  workflow: string
  /** `https://<x-forwarded-host ?? host>`; `''` when the request carries neither. */
  appOrigin: string
  /**
   * Where sibling calls go: CE in-process at the request's own base path
   * (`http://localhost:3000/public/<owner>/<repo>/alias/<alias>/<dir>` — the
   * path nginx rewrote the request to, which CE's in-process invoker keeps on
   * a sibling's request), so the harness's rules and forwarders answer without
   * a hairpin through the edge. Falls back to `appOrigin` without the prefix.
   */
  siblingBase: string
  /** The public host (`x-forwarded-host ?? host`), sent back to CE as `x-forwarded-host` on in-process calls. */
  host: string
  /** The public-relative path of each in-process call — CE's proxy middleware matches rules on `x-original-uri`, not on the `/public/…` URL. */
  aliasesUrl: string
  indexUrl: string
  indexPath: string
  stepViewUrl: string
  stepViewPath: string
  /** `workflow.sign`: the uploads-relative key when confined, else `''`. */
  signPath: string
  signStoragePath: string
}

const RUN_SCOPED = new Set([
  'workflow.status',
  'workflow.outputs',
  'workflow.submitStep',
  'workflow.submit',
  'workflow.annotate',
  'workflow.pipeline',
  'workflow.stepView',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function header(headers: FnRequest['headers'], name: string): string {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()]
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' ? first.split(',')[0].trim() : ''
}

/**
 * The files/sign rule's confinement (`files/sign/post/confine.fn.js`),
 * applied before the `signed_url` step rather than after: an uploads-relative
 * key under `workflows/` with no traversal, or nothing.
 */
export function confinedSignPath(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const path = raw.replace(/^\/+/, '').replace(/^api\/uploads\//, '').split('?')[0]
  const ok = path.startsWith('workflows/') && !path.includes('..') && !path.includes('//')
  return ok ? path : ''
}

/** Every MCP rule of the harness lives under this prefix: the endpoint (`…/mcp`), the tools (`…/mcp-tools/<name>`), the resources (`…/mcp-resources[/step-view]`). */
const MCP_PATH = '/api/workflow/mcp'
export const TOOLS_PATH = '/api/workflow/mcp-tools/'
export const RESOURCES_PATH = '/api/workflow/mcp-resources'
export const STEP_VIEW_RESOURCE_PATH = '/api/workflow/mcp-resources/step-view'

/** What a rule's own path says it is: `…/mcp-tools/submitStep` → the tool `workflow.submitStep`; `…/mcp-resources` → the list; `…/step-view` → the step view. */
export function kindOfPath(path: string): { kind: RouteKind; tool: string } {
  const at = path.indexOf(MCP_PATH)
  const tail = at === -1 ? '' : path.slice(at).split('?')[0].replace(/\/+$/, '')
  if (tail === STEP_VIEW_RESOURCE_PATH) return { kind: 'stepView', tool: '' }
  if (tail === RESOURCES_PATH) return { kind: 'resourcesList', tool: '' }
  if (tail.startsWith(TOOLS_PATH)) {
    const name = tail.slice(TOOLS_PATH.length)
    if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) return { kind: 'toolsCall', tool: canonicalToolName(`workflow.${name}`) }
  }
  return { kind: 'invalid', tool: '' }
}

/**
 * `request.path` as CE saw it is nginx's rewrite of the public request —
 * `/public/<owner>/<repo>/alias/<alias>/<dir>/api/workflow/mcp-tools/<x>` on a
 * domain mapping (CE's invoker keeps that prefix on a sibling's request) — so
 * everything before `/api/workflow/mcp` is the alias's base path on CE's own
 * router, and CE in-process at that base answers every sibling route (rules,
 * forwarders, the bundle) exactly as the edge would, minus the edge. A bare
 * path (a preview host, a dev proxy) carries no prefix and the public origin
 * is used instead.
 */
export function siblingBaseOf(path: string, appOrigin: string): string {
  const at = path.indexOf(MCP_PATH)
  const prefix = at > 0 ? path.slice(0, at) : ''
  if (prefix.startsWith('/public/')) return `${CE_BACKEND}${prefix}`
  return appOrigin
}

/** The alias API is asked only when discovery has no `impl` to go straight to, and only when there is a URL to ask. */
function withAliases(route: Route): Route {
  route.isAliases = route.isList && route.impl === '' && route.aliasesUrl !== ''
  return route
}

export function handler(data: { request: FnRequest; deployment?: FnDeployment }): Route {
  const request = data.request ?? { body: undefined, headers: {}, method: 'POST', path: '' }
  const deployment = data.deployment ?? {}
  const path = str(request.path)
  const { kind, tool } = kindOfPath(path)

  const host = header(request.headers, 'x-forwarded-host') || header(request.headers, 'host')
  const appOrigin = host === '' ? '' : `https://${host}`
  const siblingBase = siblingBaseOf(path, appOrigin)
  const owner = str(deployment.owner)
  const repo = str(deployment.repo)
  const project = owner !== '' && repo !== '' ? `${owner}/${repo}` : ''

  const route: Route = {
    kind,
    message: '',
    tool,
    args: {},
    isAliases: false,
    needsRun: false,
    isRuns: false,
    isList: false,
    isDescribe: false,
    isStepView: false,
    isSign: false,
    runId: '',
    key: '',
    impl: '',
    workflow: '',
    appOrigin,
    siblingBase,
    host,
    // CE's alias API directly (CE_BACKEND), never the harness's relay: the caller's credential is forwarded by the step.
    aliasesUrl: project === '' ? '' : `${CE_BACKEND}/api/aliases?repository=${encodeURIComponent(project)}`,
    indexUrl: '',
    indexPath: '',
    stepViewUrl: siblingBase === '' ? '' : `${siblingBase}/step.html`,
    stepViewPath: '/step.html',
    signPath: '',
    signStoragePath: '',
  }

  if (kind === 'invalid') {
    return { ...route, message: `${path || '(no path)'} is not an MCP tool or resource rule of this harness` }
  }
  if (kind === 'stepView') {
    route.isStepView = route.stepViewUrl !== ''
    return route
  }
  if (kind === 'resourcesList') {
    route.isList = true
    return withAliases(route)
  }

  // A tool rule: the arguments are the request body (CE's mcp_handler sends them as the sibling's body).
  route.args = isPlainObject(request.body) ? (request.body as Record<string, unknown>) : {}
  const args = route.args
  route.runId = str(args.runId)
  route.key = str(args.step)
  route.impl = str(args.impl)
  route.workflow = str(args.workflow)

  if (RUN_SCOPED.has(route.tool) && route.runId !== '') route.needsRun = true
  if (route.tool === 'workflow.runs' && route.impl !== '' && route.workflow !== '') route.isRuns = true
  if (route.tool === 'workflow.list') route.isList = true
  if (route.tool === 'workflow.describe' && route.impl !== '' && route.workflow !== '' && appOrigin !== '') route.isDescribe = true
  if ((route.isList || route.isDescribe) && route.impl !== '' && siblingBase !== '') {
    route.indexPath = `/w/${route.impl}/.bffless/workflows/index.json`
    route.indexUrl = `${siblingBase}${route.indexPath}`
  }
  if (route.tool === 'workflow.sign') {
    route.signPath = confinedSignPath(args.path)
    if (route.signPath !== '' && project !== '') {
      route.isSign = true
      route.signStoragePath = `${project}/uploads/${route.signPath}`
    }
  }
  return withAliases(route)
}
