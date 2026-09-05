/**
 * `driveGate` — the `run/drive` rule's decision (ADR-0006, apps#598), taken
 * once, in one place, after the run row and the implementation's `index.json`
 * are both in hand. It dispatches nothing itself: it hands the `github_api`
 * step the four values that step evaluates (`owner`, `repo`, `eventType`,
 * `payload`) and raises exactly one of two flags — `dispatch` or `refused` —
 * that the step and the two `response_handler`s are gated on. CE step
 * conditions are simple paths, so a flag per outcome is the only shape
 * available; and this must never throw, since a throw would be CE's generic
 * FUNCTION_ERROR rather than the 400 this rule means.
 *
 * The refusal order is the spec's table, and it is an order on purpose:
 *
 * 1. `BAD_REQUEST` — the body cannot be read at all, so nothing else is known.
 * 2. `RUN_NOT_FOUND` (`resume` with no row) / `RUN_EXISTS` (`run` whose id is
 *    taken) — the mode and the row disagree about what exists.
 * 3. `RUN_TERMINAL` — the run is over; a driver would have nothing to resume.
 * 4. `LEASE_LIVE` — someone has the run open in a tab. The browser owns what it
 *    claimed (07 §Driven runs): dispatching now would put a job and a person on
 *    the same run, fighting over the lease.
 * 5. `NO_DRIVER` — the implementation publishes no driver repo (or its index
 *    could not be fetched), so there is no `workflow-drive.yml` to reach.
 *
 * What is deliberately *not* checked: whether `workflow` names a workflow the
 * index lists. The caller that cares (the `workflow.start` tool, spec 10) has
 * the index in front of it and says `noWorkflow` in the vocabulary a model
 * reads; a second, differently-worded copy here would only drift. The driver
 * itself refuses an unknown target soon enough.
 *
 * A dispatch that GitHub refuses (no integration configured, a repo the token
 * cannot reach) fails the `github_api` step, and a failed step fails the
 * pipeline — CE's own error response, which the callers read as
 * `DISPATCH_FAILED`. There is no `failOnError` on that handler to soften it,
 * and softening it would be wrong anyway: an undispatched run is not a run.
 */
import { fieldsOf, rows } from './rows'
import { IMPL_PATTERN, type DrivePlan } from './drivePlan'
import type { FnRequest } from './route'

/** `run_` + 26 Crockford-base32 characters — `lib/autoStart.ts`'s `RUN_ID_PATTERN`, restated because a bundle may not import the page. */
const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/

/** `owner/name`, GitHub's own shape — what `POST /repos/{owner}/{repo}/dispatches` is built from. */
const DRIVER_REPO_PATTERN = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/

/** A run in one of these is over (`lib/runner/types.ts` `RunStatus`); only `running` can be driven. */
const TERMINAL = ['succeeded', 'failed', 'cancelled']

/** The `repository_dispatch` event type `workflow-drive.yml` listens for. */
export const EVENT_TYPE = 'workflow-drive'

export type DriveCode = '' | 'BAD_REQUEST' | 'RUN_NOT_FOUND' | 'RUN_EXISTS' | 'RUN_TERMINAL' | 'LEASE_LIVE' | 'NO_DRIVER'

export interface DriveGate {
  /** Gate of the `github_api` step and of the 202. */
  dispatch: boolean
  /** Gate of the 400. Exactly one of `dispatch`/`refused` is ever true. */
  refused: boolean
  code: DriveCode
  message: string
  /** 202 or 400 — what the answering `response_handler` declares as a literal. */
  status: number
  owner: string
  repo: string
  eventType: string
  /** `client_payload`, key for key as `workflow-drive.yml` reads it. */
  payload: Record<string, unknown>
  /** The JSON body a `response_handler` echoes: the refusal, or the receipt. */
  response: string
}

export interface DriveGateSteps {
  find?: unknown
  plan?: Partial<DrivePlan>
  index?: { ok?: boolean; status?: number; body?: unknown }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** An `http_request` step's answer as an object — CE hands it parsed, or as text when the sibling did not say JSON (`reply.ts` reads it the same way). */
function jsonBody(step: DriveGateSteps['index']): Record<string, unknown> | null {
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

function refuse(code: DriveCode, message: string): DriveGate {
  return {
    dispatch: false,
    refused: true,
    code,
    message,
    status: 400,
    owner: '',
    repo: '',
    eventType: EVENT_TYPE,
    payload: {},
    response: JSON.stringify({ code, message }),
  }
}

export function handler(data: { request?: FnRequest; steps?: DriveGateSteps }): DriveGate {
  const request = data?.request ?? { body: undefined, headers: {}, method: 'POST', path: '' }
  const steps = data?.steps ?? {}
  const plan = steps.plan ?? {}
  const body = isPlainObject(request.body) ? request.body : {}

  // --- 1. the body -------------------------------------------------------
  const runId = str(body.id)
  const mode = str(body.mode)
  const impl = str(body.impl)
  const workflow = str(body.workflow)
  if (!RUN_ID_PATTERN.test(runId)) {
    return refuse('BAD_REQUEST', '`id` must be run_ followed by 26 Crockford-base32 characters')
  }
  if (mode !== 'run' && mode !== 'resume') return refuse('BAD_REQUEST', '`mode` must be run or resume')
  if (mode === 'run') {
    if (!IMPL_PATTERN.test(impl)) return refuse('BAD_REQUEST', '`impl` must name the implementation alias to run')
    if (workflow === '') return refuse('BAD_REQUEST', '`workflow` must name the workflow to run')
    if (!isPlainObject(body.inputs)) return refuse('BAD_REQUEST', '`inputs` must be a JSON object of input values')
  }
  // The driver is told where to call the harness back; without a Host header there
  // is no origin to tell it, and a dispatch it cannot report on is worse than none.
  const harnessUrl = str(plan.appOrigin)
  if (harnessUrl === '') return refuse('BAD_REQUEST', 'this request carries no host, so the driver would have no harness URL to call back')

  // --- 2..4. the run row -------------------------------------------------
  const matched = rows(steps.find)
  const row = fieldsOf(matched[0] ?? {})
  if (mode === 'resume' && matched.length === 0) return refuse('RUN_NOT_FOUND', 'no run with this id — start one instead')
  if (mode === 'run' && matched.length > 0) return refuse('RUN_EXISTS', 'a run with this id already exists — resume it instead')
  const status = str(row.status)
  if (matched.length > 0 && TERMINAL.indexOf(status) !== -1) return refuse('RUN_TERMINAL', `this run is already ${status}`)
  // A lease is live only while it is *held and unexpired*: a parked run released
  // its lease, which is what makes it drivable at all (07 §Driven runs).
  const heldBy = str(row.leaseOwner)
  const until = typeof row.leaseUntil === 'number' ? row.leaseUntil : 0
  if (heldBy !== '' && until > Date.now()) return refuse('LEASE_LIVE', `this run is open in ${heldBy} — resume it there, or wait for the lease to expire`)

  // --- 5. the driver -----------------------------------------------------
  const index = jsonBody(steps.index)
  const driver = index !== null && isPlainObject(index.driver) ? index.driver : {}
  const parts = DRIVER_REPO_PATTERN.exec(str(driver.repo))
  if (parts === null) {
    return refuse('NO_DRIVER', 'this implementation publishes no driver repo — run it on the harness page instead')
  }
  const [full, owner, repo] = parts

  // `client_payload` as `workflow-drive.yml` reads it: `resume` carries the id
  // alone (the run row already knows its workflow and its inputs), so those two
  // keys are absent rather than null — the driver never looks at them.
  const payload: Record<string, unknown> =
    mode === 'run'
      ? { mode, run_id: runId, harness_url: harnessUrl, workflow: `${impl}/${workflow}`, inputs: body.inputs }
      : { mode, run_id: runId, harness_url: harnessUrl }

  return {
    dispatch: true,
    refused: false,
    code: '',
    message: '',
    status: 202,
    owner,
    repo,
    eventType: EVENT_TYPE,
    payload,
    response: JSON.stringify({ dispatched: true, runId, repo: full, eventType: EVENT_TYPE }),
  }
}
