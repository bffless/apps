/**
 * `runGate` — the one gate every rule that names an existing run imports
 * (spec 11 §The model (D26), §One gate, not twenty-five copies).
 *
 * A run belongs to the person who started it. The sweep that makes that true
 * touches ~25 of the rule set's 36 rules, and it stays maintainable only
 * because the decision lives here, in one bundle, rather than in twenty-five
 * hand-kept copies of the same four `if`s. Each rule keeps the established
 * shape: this function step, then one literal-status `response_handler` gated
 * on `steps.runGate.notFound`, and every later step gated on
 * `steps.runGate.ok`.
 *
 * Four doors, first match wins (spec 11 §The model):
 *
 * 1. **owner** — `startedBy === user.id`, the ordinary path.
 * 2. **drive** — the request carries the run's `driveKey`: how a dispatched
 *    driver acts on a run it does not own (D28). Only while the run is live;
 *    the key is cleared at a terminal status, and a stale one opens nothing.
 * 3. **all** — a project owner or admin who **asked** (`?scope=all`,
 *    `scope: "all"`, or the `x-workflow-scope` header). Never implicit (D27):
 *    on a project you own an implicit exemption would mean nothing ever
 *    changes, and the MCP connector's app token carries the real role.
 * 4. **grant** — a row in `workflow_run_grants`. Not built: `hasGrant` is a
 *    stub returning `false`, so sharing lands without reopening the sweep.
 *
 * Plus `runless`, which is not a door at all: the rule's earlier step said this
 * request names no run (a list, a create), so there is nothing to gate and the
 * gate says so rather than refusing.
 *
 * **404, never 403.** A run the caller cannot reach is `notFound`,
 * indistinguishable from an unknown id, so a run id in a URL leaks nothing
 * about whether it exists. The one 403 in the model belongs to the *list*
 * endpoints (an explicit `scope=all` from a caller without the role) and is
 * not this function's business.
 *
 * **Never throws.** A throw is CE's generic `FUNCTION_ERROR`, not a status we
 * get to choose, so every refusal is a returned flag — the constraint
 * `run/delete/post/gate.fn.js` already documents. Everything below reads its
 * inputs defensively for that reason, not out of superstition.
 */
import type { FnRequest } from './route'
import { fieldsOf, rows } from './rows'

/** The **project** roles (`project-permissions.schema.ts`) that may ask for all-scope. */
export const ALL_SCOPE_ROLES: ReadonlyArray<string> = ['owner', 'admin']

/** A run in one of these is over (`lib/runner/types.ts` `RunStatus`), and its `driveKey` is cleared. */
export const TERMINAL_STATUSES: ReadonlyArray<string> = ['succeeded', 'failed', 'cancelled']

/** How a caller asks for all-scope when there is no query string to put it on (the MCP endpoint's siblings). */
export const SCOPE_HEADER = 'x-workflow-scope'

/** The drive nonce `workflow-headless` carries, as it already carries `WORKFLOW_TOKEN` (`api.ts`). */
export const DRIVE_KEY_HEADER = 'x-workflow-drive-key'

/** `user` as CE's function_handler hands it (`function.handler.ts`), or `undefined` for a caller it could not tie to a person. */
export interface FnUser {
  id?: string
  email?: string
  /** CE's instance-wide role (`admin | user | member`) — not what this gate reads. */
  role?: string
  /** The role on *this project* (`owner | admin | contributor | viewer`), spec 11 §Why `projectRole`. */
  projectRole?: string
  groups?: string[]
}

/** Which door admitted the caller; `''` when none did. */
export type Door = 'owner' | 'drive' | 'all' | 'grant' | 'runless' | ''

export interface RunGate {
  /** The caller may act on the run named by `steps.run` (or the request names no run). */
  ok: boolean
  /** No such run, or not this caller's — the two are one answer (D26). */
  notFound: boolean
  door: Door
  /** The run row's record id, for `data_update`/`data_delete`; `null` unless ok. */
  recordId: string | null
  /** The run's columns (`fieldsOf`), `null` unless ok and a row exists. */
  run: Record<string, unknown> | null
  /** The refusal body one literal-status responder renders; `null` on ok. */
  result: { ok: false; error: string } | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * A header's first value, case-insensitively. CE lowercases what Express hands
 * it, but a rule can be reached in-process by a sibling that did not, so the
 * names are compared lowercased rather than looked up. A repeated header
 * arrives as `string[]`; the first value is the one that was sent first.
 */
export function header(request: FnRequest | undefined, name: string): string {
  const headers = isPlainObject(request) ? request.headers : undefined
  if (!isPlainObject(headers)) return ''
  const wanted = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue
    const value = headers[key]
    const first = Array.isArray(value) ? value[0] : value
    return str(first).trim()
  }
  return ''
}

/**
 * The caller **asked** for all-scope (D27) — on the query string, in the body
 * (the MCP tools take their arguments there), or on the header. Any of the
 * three may be absent or not an object; none of them is trusted for anything
 * but the question, since the role is checked separately.
 */
export function scopeAsked(request: FnRequest | undefined): boolean {
  const query = isPlainObject(request) ? request.query : undefined
  const body = isPlainObject(request) ? request.body : undefined
  if (isPlainObject(query) && query.scope === 'all') return true
  if (isPlainObject(body) && body.scope === 'all') return true
  return header(request, SCOPE_HEADER) === 'all'
}

/** Is this the **project** role that may widen the scope (spec 11 §Why `projectRole`)? */
export function isAllScopeRole(projectRole: unknown): boolean {
  return ALL_SCOPE_ROLES.indexOf(str(projectRole).toLowerCase()) !== -1
}

/**
 * Sharing — a row in `workflow_run_grants` — is **not built** (spec 11 §The
 * model). The door exists, and every rule already calls through it, so landing
 * grants need not reopen the sweep across ~25 rules.
 */
export function hasGrant(_run: Record<string, unknown>, _user: FnUser): boolean {
  void _run
  void _user
  return false
}

function refuse(): RunGate {
  return {
    ok: false,
    notFound: true,
    door: '',
    recordId: null,
    run: null,
    result: { ok: false, error: 'run not found' },
  }
}

function admit(door: Door, row: Record<string, unknown>, fields: Record<string, unknown>): RunGate {
  return {
    ok: true,
    notFound: false,
    door,
    // Wherever this CE keeps the record id — on the record, or among the
    // columns (`rows.ts` `recordIdOf` reads both) — as the string a
    // `data_update`/`data_delete` step interpolates.
    recordId: String(row.id ?? fields.id ?? '') || null,
    run: fields,
    result: null,
  }
}

/**
 * The gate over already-loaded rows — what `handler` does, and what another
 * bundle (`driveGate`, `reply`, `merge`, `plan`) calls when it has the run row
 * in hand and must take the same decision.
 */
export function gateRun(input: {
  run: unknown
  runless?: boolean
  request?: FnRequest
  user?: FnUser
}): RunGate {
  const { run, runless, request } = input
  // 0. Nothing to gate: the rule's earlier step said this request names no run.
  if (runless === true) {
    return { ok: true, notFound: false, door: 'runless', recordId: null, run: null, result: null }
  }

  const row = rows(run)[0]
  if (!row) return refuse()
  const f = fieldsOf(row)
  const caller: FnUser = isPlainObject(input.user) ? (input.user as FnUser) : {}
  const startedBy = str(f.startedBy)

  // 1. owner. `!caller.id` closes the hole `undefined === undefined` opens: an
  // id-less caller must never own a row that is *also* id-less, which is what
  // makes an ownerless run admin-only by construction rather than everyone's
  // (`run/delete/post/gate.fn.js`, mirrored).
  if (str(caller.id) !== '' && startedBy !== '' && startedBy === str(caller.id)) return admit('owner', row, f)

  // 2. the drive nonce, while the run is live (D28).
  const key = header(request, DRIVE_KEY_HEADER)
  const rowKey = str(f.driveKey)
  if (key !== '' && rowKey !== '' && key === rowKey && TERMINAL_STATUSES.indexOf(str(f.status)) === -1) {
    return admit('drive', row, f)
  }

  // 3. all-scope: the role AND the asking (D27).
  if (scopeAsked(request) && isAllScopeRole(caller.projectRole)) return admit('all', row, f)

  // 4. a grant — not built.
  if (hasGrant(f, caller)) return admit('grant', row, f)

  return refuse()
}

/**
 * The run a later bundle in the same rule may read: the row **this gate
 * admitted**, and nothing else. `undefined` is the shape its callers already
 * handle.
 *
 * It returns `steps.runGate.run` rather than re-reading `steps.run`, so it is
 * structurally incapable of handing back a row no door opened: on the
 * `runless` door the gate says `ok` with `run: null` while `steps.run` may
 * still hold rows, and a helper that re-derived the row from the query would
 * quietly admit one there.
 */
export function admittedRun(steps: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!isPlainObject(steps)) return undefined
  const gate = steps.runGate
  if (!isPlainObject(gate) || gate.ok !== true) return undefined
  return isPlainObject(gate.run) ? gate.run : undefined
}

/**
 * CE's `function_handler` entry. The run row is whichever `data_query` step the
 * rule calls `run`; `runless` is raised by whichever earlier function step the
 * rule already has (`route` on the MCP tool rules, `confine` on the file rules,
 * `normalize` elsewhere) — all three are read, since a rule has exactly one of
 * them and a missing step is simply `undefined`.
 */
export function handler(data: { steps?: Record<string, unknown>; request?: FnRequest; user?: FnUser }): RunGate {
  const steps = isPlainObject(data) && isPlainObject(data.steps) ? data.steps : {}
  const runless = [steps.route, steps.confine, steps.normalize].some(
    (step) => isPlainObject(step) && step.runless === true,
  )
  return gateRun({
    run: steps.run,
    runless,
    request: isPlainObject(data) ? data.request : undefined,
    user: isPlainObject(data) ? data.user : undefined,
  })
}
