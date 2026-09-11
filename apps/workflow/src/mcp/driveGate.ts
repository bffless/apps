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
 * 2. `NO_RANDOM` — this CE exposes no `utils.randomToken`, so the driver's
 *    nonce cannot be minted, so the run cannot be attributed (D28). Refusing
 *    beats dispatching a run nobody will own.
 * 3. `RUN_NOT_FOUND` (`resume` the shared run gate did not open — an unknown
 *    id and someone else's run are one answer, D26) / `RUN_EXISTS` (`run`
 *    whose id is taken) — the mode and the row disagree about what exists.
 * 4. `RUN_TERMINAL` — the run is over; a driver would have nothing to resume.
 * 5. `LEASE_LIVE` — someone has the run open in a tab. The browser owns what it
 *    claimed (07 §Driven runs): dispatching now would put a job and a person on
 *    the same run, fighting over the lease.
 * 6. `NO_DRIVER` — the implementation publishes no driver repo (or its index
 *    could not be fetched), so there is no `workflow-drive.yml` to reach.
 * 7. `RUN_EXISTS` again, at the very end: this id is already claimed by
 *    another member (D28) — unless that claim has gone stale, in which case
 *    this caller takes the id over instead (`CLAIM_STALE_MS`, apps#672).
 *
 * Past the refusals it decides one more thing the pipeline executes for it:
 * **whose run this is** (spec 11 §Attribution, D28). The run will be created
 * by the DRIVER's identity, inside the browser the job opens, so this request —
 * the last point in the chain carrying the requester's credential — writes a
 * `workflow_run_claims` row (`writeClaim`/`claim`) or re-keys the existing run
 * (`rekey`/`recordId`), and hands the driver the nonce in `client_payload`.
 * The nonce never appears in a response body.
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
import { fieldsOf, recordIdOf, rows } from './rows'
import { IMPL_PATTERN, type DrivePlan } from './drivePlan'
import { admittedRun, type FnUser } from './runGate'
import type { FnRequest, FnUtils } from './route'

/** `run_` + 26 Crockford-base32 characters — `lib/autoStart.ts`'s `RUN_ID_PATTERN`, restated because a bundle may not import the page. */
const RUN_ID_PATTERN = /^run_[0-9A-HJKMNP-TV-Z]{26}$/

/** `owner/name`, GitHub's own shape — what `POST /repos/{owner}/{repo}/dispatches` is built from. */
const DRIVER_REPO_PATTERN = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/

/** A run in one of these is over (`lib/runner/types.ts` `RunStatus`); only `running` can be driven. */
const TERMINAL = ['succeeded', 'failed', 'cancelled']

/**
 * How long another member's claim holds a run id (apps#672). A claim is written
 * BEFORE the dispatch, so a dispatch that never lands leaves one standing with
 * no run behind it; without a window, that row refuses the id to everyone else
 * forever. Eight minutes is not a new number: it is the driven walk's
 * `POLL_TIMEOUT_MS` (`packages/workflow-live/src/walks/driven.ts`), the
 * harness's own estimate of how long a dispatch may reasonably take to start
 * producing writes — *"an Actions cold start is ~1–2 minutes; two of them plus
 * the run itself fit well inside this"*. Past it, a claim with no run is not
 * pending, it is abandoned. (`workflow-headless`'s 60-minute `--timeout` bounds
 * a whole RUN, not a dispatch's pickup, and is the wrong figure here.)
 */
const CLAIM_STALE_MS = 8 * 60_000

/** The `repository_dispatch` event type `workflow-drive.yml` listens for. */
export const EVENT_TYPE = 'workflow-drive'

export type DriveCode =
  | ''
  | 'BAD_REQUEST'
  | 'RUN_NOT_FOUND'
  | 'RUN_EXISTS'
  | 'RUN_TERMINAL'
  | 'LEASE_LIVE'
  | 'NO_DRIVER'
  | 'NO_RANDOM'

/** The `workflow_run_claims` row the rule's `claimWrite` step inserts (spec 11 §Attribution, D28). */
export interface DriveClaim {
  runId: string
  impl: string
  workflow: string
  startedBy: string
  startedByEmail: string
  driveKey: string
  createdAt: number
}

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

  // --- attribution (spec 11 §Attribution, D28) ----------------------------
  /** Gate of the `claimWrite` step: `mode: run` with no claim of this caller's yet. */
  writeClaim: boolean
  /** Gate of the `claimReplace` step: another member's claim has gone stale, so `claim` overwrites their row in place (apps#672). */
  staleReplace: boolean
  /** Gate of the `rekey` step: `mode: resume` writes the nonce straight onto the run row. */
  rekey: boolean
  /** The run row's record id, for `rekey`'s `data_update`; `''` unless `rekey`. */
  recordId: string
  /** The STALE CLAIM row's record id, for `claimReplace`'s `data_update`; `''` unless `staleReplace`. */
  claimRecordId: string
  /** The nonce the driver will carry back as `x-workflow-drive-key`; `''` on a refusal. */
  driveKey: string
  /** The claim row `claimWrite` inserts — or the one this caller already holds; `null` on `resume` and on a refusal. */
  claim: DriveClaim | null
}

export interface DriveGateSteps {
  /** The `workflow_runs` rows `id` matched (the `run` data_query). */
  run?: unknown
  /** The `workflow_run_claims` rows `id` matched (the `claim` data_query). */
  claim?: unknown
  /** The shared run gate's answer — present only on a `resume` (the step is gated on `steps.plan.isResume`). */
  runGate?: unknown
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

/**
 * The record id the shared gate already computed for the admitted run — what
 * `rekey`'s `data_update` interpolates. It is read from the GATE rather than
 * re-derived from the admitted row's columns because the id lives on the
 * *record*, outside `fields`, wherever this CE puts it (`rows.ts` `recordIdOf`
 * reads both, and `admittedRun` hands back the columns alone).
 */
function gateRecordId(steps: DriveGateSteps): string {
  const gate = steps.runGate
  return isPlainObject(gate) && typeof gate.recordId === 'string' ? gate.recordId : ''
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
    writeClaim: false,
    staleReplace: false,
    rekey: false,
    recordId: '',
    claimRecordId: '',
    driveKey: '',
    claim: null,
  }
}

export function handler(data: {
  request?: FnRequest
  steps?: DriveGateSteps
  user?: FnUser
  utils?: FnUtils
}): DriveGate {
  const request = data?.request ?? { body: undefined, headers: {}, method: 'POST', path: '' }
  const steps = data?.steps ?? {}
  const plan = steps.plan ?? {}
  const body = isPlainObject(request.body) ? request.body : {}
  const user: FnUser = isPlainObject(data?.user) ? (data.user as FnUser) : {}

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

  // The driver's nonce has to be unguessable — it is the only thing that lets a
  // job act on a run it does not own (D26 door 2), and the only thing that
  // redeems the claim at `runs/post`. `Math.random` is not that, so a CE
  // without `utils.randomToken` gets a refusal rather than a weaker key: a
  // fixed 400, never a throw, which would be CE's generic FUNCTION_ERROR.
  const mint = typeof data?.utils?.randomToken === 'function' ? data.utils.randomToken : null
  if (mint === null) {
    return refuse('NO_RANDOM', 'this CE exposes no utils.randomToken — the driver nonce cannot be minted')
  }

  // --- 2..4. the run row -------------------------------------------------
  // `resume` names an existing run, so it goes through the SHARED run gate
  // (spec 11 D26, the rule's `runGate` step, gated on `steps.plan.isResume`):
  // a run this caller cannot reach answers exactly what an unknown id answers,
  // so a run id leaks nothing. `run` skips the gate — there is no row to open —
  // and its own backstop is the id being free.
  const matched = rows(steps.run)
  if (mode === 'resume' && !(isPlainObject(steps.runGate) && steps.runGate.ok === true)) {
    return refuse('RUN_NOT_FOUND', 'no run with this id — start one instead')
  }
  if (mode === 'run' && matched.length > 0) return refuse('RUN_EXISTS', 'a run with this id already exists — resume it instead')
  // The row the gate ADMITTED, never one re-derived from the query (`admittedRun`);
  // on `run` there is none, and an empty row fails no check below.
  const row = admittedRun(steps as Record<string, unknown>) ?? {}
  const status = str(row.status)
  if (TERMINAL.indexOf(status) !== -1) return refuse('RUN_TERMINAL', `this run is already ${status}`)
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

  // --- 6. attribution (spec 11 §Attribution, D28) ------------------------
  // The run about to be dispatched will be CREATED by the driver's identity,
  // inside the browser the job opens. This request is the last place the
  // requester's credential exists, so whose run it is has to be decided here.
  let writeClaim = false
  let staleReplace = false
  let rekey = false
  let recordId = ''
  let claimRecordId = ''
  // No initialiser: every branch below mints or reuses a key before anything
  // reads it, and a placeholder here would be a key-shaped value that is not one.
  let driveKey: string
  let claim: DriveClaim | null = null

  if (mode === 'resume') {
    // The row already records its owner, so there is nothing to claim — only a
    // nonce to hand the driver. It is minted FRESH every time rather than
    // reusing whatever `driveKey` the row carries: a key handed to a previous
    // driver stops opening the run the moment a new one is dispatched.
    driveKey = mint(24)
    rekey = true
    recordId = gateRecordId(steps) || str(row.id)
  } else {
    // An unattributable run is not a run: without a member id there is nothing
    // to put in `startedBy`, and `runs/post` would fall through to the
    // driver's own identity — the exact outcome the claim exists to prevent.
    const callerId = str(user.id)
    if (callerId === '') return refuse('BAD_REQUEST', 'the endpoint could not tie this caller to a member')

    const held = rows(steps.claim)
    const existing = held.length > 0 ? fieldsOf(held[0]) : null
    if (existing !== null && str(existing.startedBy) !== callerId) {
      // Someone else asked for this id first — but a claim is evidence of a
      // DISPATCH, not of a run: `claimWrite` commits before `dispatch`, so a
      // `github_api` failure, a driver whose repo never picks the event up, or
      // a job that dies before its first write all leave a claim standing with
      // no run behind it. Past `CLAIM_STALE_MS` there is nothing left to wait
      // for, so this caller takes the id over (`staleReplace` → the rule's
      // `claimReplace`, which overwrites their row rather than adding a second
      // one beside it) instead of being refused an id nobody will ever use
      // (apps#672). A row whose `createdAt` this CE did not hand back as a
      // number reads as claimed NOW — the own-claim branch below hedges the
      // same way, and erring the other way would make every foreign claim
      // takeable on a guess, which is the one failure this branch must not have.
      const claimedAt = typeof existing.createdAt === 'number' ? existing.createdAt : Date.now()
      const claimId = recordIdOf(held[0])
      // Inside the window — or a row this CE gave no id for, which `data_update`
      // could not key anyway — is the original answer. Same code as a run that
      // already exists, and deliberately so: from the caller's side an id that
      // is spoken for is an id that is spoken for.
      if (Date.now() - claimedAt <= CLAIM_STALE_MS || claimId === null) {
        return refuse('RUN_EXISTS', 'this run id is already claimed by another member')
      }
      staleReplace = true
      claimRecordId = claimId
    }
    if (existing !== null && !staleReplace) {
      // Our own claim, from a dispatch that did not land (or a duplicate call).
      // Reusing it — rather than writing a second row or a second key — is what
      // makes a retry after a failed `github_api` step safe.
      driveKey = str(existing.driveKey)
      claim = {
        runId,
        impl,
        workflow,
        startedBy: callerId,
        startedByEmail: str(existing.startedByEmail),
        driveKey,
        createdAt: typeof existing.createdAt === 'number' ? existing.createdAt : Date.now(),
      }
    } else {
      // A free id and a staled-out one mint exactly the same claim — a fresh
      // nonce and this caller's name. All that differs is which step writes it:
      // `claimWrite`'s `data_create` for a free id, `claimReplace`'s
      // `data_update` over the abandoned row for a stale one.
      driveKey = mint(24)
      writeClaim = !staleReplace
      claim = {
        runId,
        impl,
        workflow,
        startedBy: callerId,
        startedByEmail: str(user.email),
        driveKey,
        createdAt: Date.now(),
      }
    }
  }

  // `client_payload` as `workflow-drive.yml` reads it: `resume` carries the id
  // alone (the run row already knows its workflow and its inputs), so those two
  // keys are absent rather than null — the driver never looks at them.
  // `drive_key` rides BOTH modes: it is how the job proves, on every request its
  // browser makes, that it is the driver this endpoint dispatched.
  const payload: Record<string, unknown> =
    mode === 'run'
      ? { mode, run_id: runId, harness_url: harnessUrl, workflow: `${impl}/${workflow}`, inputs: body.inputs, drive_key: driveKey }
      : { mode, run_id: runId, harness_url: harnessUrl, drive_key: driveKey }

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
    // The receipt the caller reads. The nonce is NOT in it: it reaches the
    // driver through `client_payload` and nowhere else.
    response: JSON.stringify({ dispatched: true, runId, repo: full, eventType: EVENT_TYPE }),
    writeClaim,
    staleReplace,
    rekey,
    recordId,
    claimRecordId,
    driveKey,
    claim,
  }
}
