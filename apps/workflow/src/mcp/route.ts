/**
 * `route` — the MCP endpoint rule's first function step (spec 10, D22; Phase 2
 * plan, Task 3). One JSON-RPC message in; out, everything the pipeline's
 * *static* steps need to know: one boolean per condition-gated step (CE step
 * conditions are simple paths, never compound — so every gate is a flag
 * computed here) and every URL or storage path a `http_request` / `signed_url`
 * step will read as an expression (`url: steps.route.aliasesUrl`).
 *
 * Nothing here does I/O: a function_handler cannot. It plans; the pipeline
 * executes; `reply` assembles. What needs an earlier step's answer (the index
 * file to fetch a workflow's YAML from, the island a waiting step names) is
 * `plan`'s job, one step later.
 */
import { canonicalToolName } from '@bffless/workflow-agent-tools'
import { STEP_VIEW_URI } from './hostTools'
import { parseMessage, type Id } from './jsonrpc'

export const LIST_FANOUT = 3

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

export type RouteKind =
  | 'initialize'
  | 'ping'
  | 'toolsList'
  | 'toolsCall'
  | 'resourcesList'
  | 'resourcesRead'
  | 'notification'
  | 'unknown'
  | 'invalid'

export interface Route {
  kind: RouteKind
  id: Id
  method: string
  /** `invalid`: why. */
  message: string
  /** `toolsCall`: the dot-canonical tool name; `''` otherwise. */
  tool: string
  args: Record<string, unknown>
  /** `resourcesRead`: the requested URI. */
  uri: string
  /** The client's `initialize` params (protocolVersion, clientInfo), for `reply`. */
  params: Record<string, unknown>

  // --- one flag per gated step -------------------------------------------
  isNotification: boolean
  /** Everything that is not a notification gets a JSON-RPC body — gates the final `respond` step. */
  isRequest: boolean
  /** The request named a host, so the derived URLs are real — gates `identity`. */
  hasOrigin: boolean
  /** `list` / `resources/list` without `impl` → `steps.aliases` (the harness's alias relay). */
  isAliases: boolean
  /** Read the run row + its step rows (`steps.run`, `steps.steps`). */
  needsRun: boolean
  /** `workflow.runs` with impl + workflow → `steps.runs` + `steps.waiting`. */
  isRuns: boolean
  /** Discovery: `steps.aliases` then `plan` then `index1..3`. */
  isList: boolean
  /** `workflow.describe` → `steps.index` (then `plan` names the YAML). */
  isDescribe: boolean
  /** `resources/read` of `ui://bffless/<impl>/…` — `plan` fences and names the file. */
  isIslandUri: boolean
  /** `resources/read` of the step view → `steps.stepView`. */
  isStepView: boolean
  /** Any `resources/read` — the storage-origin probe (`steps.probe`). */
  isCsp: boolean
  /** `workflow.sign` with a confined path → `steps.signed`. */
  isSign: boolean

  // --- derived values the gated steps read ---------------------------------
  runId: string
  key: string
  impl: string
  workflow: string
  /** `resources/read`: the path after `ui://bffless/<impl>/`. */
  rest: string
  /** `https://<x-forwarded-host ?? host>`; `''` when the request carries neither. */
  appOrigin: string
  whoamiUrl: string
  aliasesUrl: string
  indexUrl: string
  stepViewUrl: string
  /** `workflow.sign`: the uploads-relative key when confined, else `''`. */
  signPath: string
  signStoragePath: string
  probePath: string
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

const UI_PREFIX = 'ui://bffless/'

/** `ui://bffless/<impl>/<rest>` → `{ impl, rest }`; `null` for anything else (including the step view). */
export function parseIslandUri(uri: string): { impl: string; rest: string } | null {
  if (!uri.startsWith(UI_PREFIX) || uri === STEP_VIEW_URI) return null
  const tail = uri.slice(UI_PREFIX.length)
  const slash = tail.indexOf('/')
  if (slash <= 0) return null
  const impl = tail.slice(0, slash)
  const rest = tail.slice(slash + 1)
  if (!/^[a-z][a-z0-9-]*$/.test(impl) || rest === '') return null
  return { impl, rest }
}

/** The alias relay is asked only when discovery has no `impl` to go straight to, and only when there is a URL to ask. */
function withAliases(route: Route): Route {
  route.isAliases = route.isList && route.impl === '' && route.aliasesUrl !== ''
  return route
}

export function handler(data: { request: FnRequest; deployment?: FnDeployment }): Route {
  const request = data.request ?? { body: undefined, headers: {}, method: 'POST', path: '' }
  const deployment = data.deployment ?? {}
  const message = parseMessage(request.body)

  const host = header(request.headers, 'x-forwarded-host') || header(request.headers, 'host')
  const appOrigin = host === '' ? '' : `https://${host}`
  const owner = str(deployment.owner)
  const repo = str(deployment.repo)
  const project = owner !== '' && repo !== '' ? `${owner}/${repo}` : ''

  const route: Route = {
    kind: 'unknown',
    id: null,
    method: '',
    message: '',
    tool: '',
    args: {},
    uri: '',
    params: {},
    isNotification: false,
    isRequest: true,
    hasOrigin: appOrigin !== '',
    isAliases: false,
    needsRun: false,
    isRuns: false,
    isList: false,
    isDescribe: false,
    isIslandUri: false,
    isStepView: false,
    isCsp: false,
    isSign: false,
    runId: '',
    key: '',
    impl: '',
    workflow: '',
    rest: '',
    appOrigin,
    whoamiUrl: appOrigin === '' ? '' : `${appOrigin}/api/workflow/whoami`,
    aliasesUrl: appOrigin === '' || project === '' ? '' : `${appOrigin}/api/workflow/aliases?repository=${encodeURIComponent(project)}`,
    indexUrl: '',
    stepViewUrl: appOrigin === '' ? '' : `${appOrigin}/step.html`,
    signPath: '',
    signStoragePath: '',
    probePath: project === '' ? '' : `${project}/uploads/workflows/.mcp-csp-probe`,
  }

  if (message.kind === 'invalid') {
    return { ...route, kind: 'invalid', id: message.id, message: message.message }
  }
  route.method = message.method
  route.params = message.params
  if (message.kind === 'notification') {
    return { ...route, kind: 'notification', isNotification: true, isRequest: false }
  }
  route.id = message.id

  switch (message.method) {
    case 'initialize':
      route.kind = 'initialize'
      return route
    case 'ping':
      route.kind = 'ping'
      return route
    case 'tools/list':
      route.kind = 'toolsList'
      return route
    case 'resources/list':
      route.kind = 'resourcesList'
      route.isList = true
      return withAliases(route)
    case 'resources/read': {
      route.kind = 'resourcesRead'
      route.uri = str(message.params.uri)
      route.isCsp = route.probePath !== ''
      if (route.uri === STEP_VIEW_URI) {
        route.isStepView = route.stepViewUrl !== ''
      } else {
        const island = parseIslandUri(route.uri)
        if (island) {
          route.isIslandUri = true
          route.impl = island.impl
          route.rest = island.rest
        }
      }
      return route
    }
    case 'tools/call':
      break
    default:
      route.kind = 'unknown'
      return route
  }

  route.kind = 'toolsCall'
  route.tool = canonicalToolName(str(message.params.name))
  route.args = isPlainObject(message.params.arguments) ? message.params.arguments : {}
  const args = route.args
  route.runId = str(args.runId)
  route.key = str(args.step)
  route.impl = str(args.impl)
  route.workflow = str(args.workflow)

  if (RUN_SCOPED.has(route.tool) && route.runId !== '') route.needsRun = true
  if (route.tool === 'workflow.runs' && route.impl !== '' && route.workflow !== '') route.isRuns = true
  if (route.tool === 'workflow.list') route.isList = true
  if (route.tool === 'workflow.describe' && route.impl !== '' && route.workflow !== '' && appOrigin !== '') route.isDescribe = true
  if ((route.isList || route.isDescribe) && route.impl !== '' && appOrigin !== '') {
    route.indexUrl = `${appOrigin}/w/${route.impl}/.bffless/workflows/index.json`
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
