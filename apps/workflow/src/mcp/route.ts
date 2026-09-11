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
// The gate's own reader of the project role, so "who may widen a listing"
// is decided by ONE function for both surfaces (spec 11, D27). The import
// cycle back to this module is types only (`FnRequest`), which esbuild erases.
import { isAllScopeRole, type FnUser } from './runGate'

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

/**
 * `utils` as CE's function_handler hands it (`function-runner.service.ts`
 * `buildUtils`) — declared with the one helper this rule set needs, and every
 * member optional because a CE older than the one that added it hands a
 * `utils` without it (or none at all). A bundle that wants it must check
 * before calling; there is no polyfill for crypto-strong randomness.
 */
export interface FnUtils {
  /** `bytes` (default 18, capped at 64) of crypto-strong randomness, hex-encoded — so `randomToken(24)` is 48 hex characters. */
  randomToken?: (bytes?: number) => string
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
  /** `workflow.runs` with impl + workflow. Says the CALL is a listing; it does not say the listing runs — see `listRuns`. */
  isRuns: boolean
  /**
   * `isRuns` AND the scope was not refused → `steps.waiting` (the step-row
   * query the listing decorates its rows with). A forbidden `scope: "all"`
   * runs neither run query, so the waiting query must not run either — it is
   * work for a listing that `reply` answers with a 403 (fix round 2). A step
   * `condition` is a single path, so this is a flag rather than an expression.
   */
  listRuns: boolean
  /**
   * `workflow.runs` listing the caller's OWN runs → `steps.runs` (the query
   * filtered on `startedBy: user.id`). The default: a filter cannot be
   * conditional, so "mine or everything" is two queries and this flag picks
   * one (spec 11 §Listing: two queries).
   */
  isMine: boolean
  /** `workflow.runs` listing every run of the workflow → `steps.runsAll` (the unfiltered query). Asked for AND allowed (D27). */
  isAll: boolean
  /**
   * `scope: "all"` from a caller without the project owner/admin role — the
   * one 403 in the list model (D27). Neither query runs; `reply` refuses.
   */
  scopeForbidden: boolean
  /**
   * This request names no run, so the shared gate has nothing to judge and
   * says `ok` rather than refusing (spec 11 §The model, the `runless` door).
   * Only `workflow.sign` of a member-wide `inputs/` key raises it here: every
   * other tool either names a run or never reads one.
   */
  runless: boolean
  /** Discovery: `steps.aliases` then `plan` then `index1..3`. */
  isList: boolean
  /** `workflow.describe` → `steps.index` (then `plan` names the YAML). */
  isDescribe: boolean
  /**
   * `workflow.start` over the endpoint (ADR-0006): dispatch this
   * implementation's driver for a run of this workflow. The index is read
   * first — `plan` needs the driver repo it publishes, and the workflow it
   * lists, before there is anything to dispatch.
   */
  isStart: boolean
  /** `workflow.resume` over the endpoint: dispatch a driver to take an existing run over. */
  isResume: boolean
  /** Gate of the `index` step: `describe` reads the listing, `start` reads the driver. */
  needsIndex: boolean
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
  /**
   * The harness's own `run/drive` rule (ADR-0006), reached in-process like
   * every other sibling: one rule owns the dispatch, and the three tools that
   * dispatch (`start`, `resume`, `submitStep`) all post the same body to it.
   * `plan` copies both onto itself so the `drive` step reads one source.
   */
  driveUrl: string
  drivePath: string
}

/**
 * The eleven run-scoped tools (spec 11 §One gate, not twenty-five copies): the
 * seven catalog tools that take a `runId` and the four host tools. Each reads
 * the run row through the shared gate, so `needsRun` is what makes the `run`
 * query run and the gate judge it.
 *
 * `await` and `cancel` are here even though this endpoint serves neither: a
 * refusal that explains the tool is still an answer about a specific run, and
 * a run the caller cannot reach must answer what an unknown id answers.
 */
const RUN_SCOPED = new Set([
  'workflow.status',
  'workflow.outputs',
  'workflow.submitStep',
  'workflow.submit',
  'workflow.annotate',
  'workflow.pipeline',
  'workflow.stepView',
  'workflow.await',
  'workflow.cancel',
  // `sign` is run-scoped through the PATH it signs, not through an argument
  // (D29) — the branch below replaces this flag with what the path says.
  'workflow.sign',
  // A resume names nothing but the run: its rows say which implementation to dispatch.
  'workflow.resume',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** One request header, first value, trimmed — `''` when absent. Shared with `drivePlan` (ADR-0006), which derives the same origin this does. */
export function header(headers: FnRequest['headers'], name: string): string {
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
  // `/./` is refused alongside `..` and `//` (fix round 2): a local-filesystem storage
  // adapter normalises it away, so `workflows/a/./runs/…` and `workflows/a/runs/…` name one
  // object while only the second is the path the run was read off.
  const ok = path.startsWith('workflows/') && !path.includes('..') && !path.includes('//') && !path.includes('/./')
  return ok ? path : ''
}

/**
 * A run id as the page mints one (`lib/autoStart.ts`), restated here because a bundle imports
 * nothing from the app. Case-INSENSITIVE for the same reason the `runs` segment below is (fix
 * round 2): a miscased id reaches the same stored object on a case-insensitive volume, so
 * failing to capture it would read `runless` and admit the path member-wide. Captured verbatim,
 * a miscased id simply matches no `runId eq` row — a 404, the fail-closed answer.
 */
const RUN_ID_PATTERN = /^run_[0-9A-Za-z]+$/i

/**
 * The run a confined sign path belongs to, or `''` — the same locator
 * `files/sign/post/confine.fn.js` runs (spec 11 D29), `runs` matched
 * CASE-INSENSITIVELY for the same reason: CE's storage key is built from the
 * raw path with no case folding, so on a case-insensitive volume `RUNS/run_X/…`
 * and `runs/run_X/…` name the same object and the gate must be at least as
 * strict as that key equality.
 */
export function runIdOfSignPath(path: string): string {
  const match = /^workflows\/[^/]+\/[^/]+\/runs\/([^/]+)/i.exec(path)
  return match && RUN_ID_PATTERN.test(match[1]) ? match[1] : ''
}

/** Every MCP rule of the harness lives under this prefix: the endpoint (`…/mcp`), the tools (`…/mcp-tools/<name>`), the resources (`…/mcp-resources[/step-view]`). */
const MCP_PATH = '/api/workflow/mcp'
export const TOOLS_PATH = '/api/workflow/mcp-tools/'
export const RESOURCES_PATH = '/api/workflow/mcp-resources'
/** The harness's driven-runs rule (ADR-0006) — its own public path, outside `mcp*`; `drivePlan` reads it as its `siblingBaseOf` marker. */
export const DRIVE_PATH = '/api/workflow/run/drive'
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
 *
 * `marker` is the rule's own public path — everything before it is the prefix.
 * It defaults to the MCP endpoint's, which is every caller here; the `drive`
 * rule (ADR-0006) passes its own, since it lives outside `mcp*`.
 */
export function siblingBaseOf(path: string, appOrigin: string, marker: string = MCP_PATH): string {
  const at = path.indexOf(marker)
  const prefix = at > 0 ? path.slice(0, at) : ''
  if (prefix.startsWith('/public/')) return `${CE_BACKEND}${prefix}`
  return appOrigin
}

/** The alias API is asked only when discovery has no `impl` to go straight to, and only when there is a URL to ask. */
function withAliases(route: Route): Route {
  route.isAliases = route.isList && route.impl === '' && route.aliasesUrl !== ''
  return route
}

export function handler(data: { request: FnRequest; deployment?: FnDeployment; user?: FnUser }): Route {
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
    listRuns: false,
    isMine: false,
    isAll: false,
    scopeForbidden: false,
    runless: false,
    isList: false,
    isDescribe: false,
    isStart: false,
    isResume: false,
    needsIndex: false,
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
    driveUrl: siblingBase === '' ? '' : `${siblingBase}${DRIVE_PATH}`,
    drivePath: DRIVE_PATH,
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
  if (route.isRuns) {
    // The ask is explicit and never implicit (D27): on a project you own, an
    // implicit exemption would mean nothing ever changes. The role is the
    // caller's role on THIS project, which the MCP connector's app token
    // carries like any other credential.
    const asked = args.scope === 'all'
    route.scopeForbidden = asked && !isAllScopeRole(data.user?.projectRole)
    route.isAll = asked && !route.scopeForbidden
    route.isMine = !asked
    // The listing really runs: neither run query runs when the scope is
    // refused, so the `waiting` step-row query must not run either.
    route.listRuns = !route.scopeForbidden
  }
  if (route.tool === 'workflow.list') route.isList = true
  if (route.tool === 'workflow.describe' && route.impl !== '' && route.workflow !== '' && appOrigin !== '') route.isDescribe = true
  if (route.tool === 'workflow.start' && route.impl !== '' && route.workflow !== '' && siblingBase !== '') route.isStart = true
  if (route.tool === 'workflow.resume' && route.runId !== '') route.isResume = true
  route.needsIndex = route.isDescribe || route.isStart
  if ((route.isList || route.isDescribe || route.isStart) && route.impl !== '' && siblingBase !== '') {
    route.indexPath = `/w/${route.impl}/.bffless/workflows/index.json`
    route.indexUrl = `${siblingBase}${route.indexPath}`
  }
  if (route.tool === 'workflow.sign') {
    route.signPath = confinedSignPath(args.path)
    if (route.signPath !== '' && project !== '') {
      route.isSign = true
      route.signStoragePath = `${project}/uploads/${route.signPath}`
    }
    // What the gate judges is the run the PATH is under, never the `runId`
    // argument: the object is what gets signed, so a key under someone else's
    // run must be judged against that run even if the caller names their own
    // (D29, `files/sign/post/confine.fn.js` mirrored). A signable key that is
    // under no run (`inputs/…`) is member-wide, which is `runless`; an
    // unsignable path is neither, so the gate refuses, the `signed` step never
    // runs, and `reply` answers with the confinement refusal.
    route.runId = route.isSign ? runIdOfSignPath(route.signPath) : ''
    route.needsRun = route.runId !== ''
    route.runless = route.isSign && route.runId === ''
  }
  return withAliases(route)
}
