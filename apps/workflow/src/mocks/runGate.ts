/**
 * The mock's re-implementation of the harness's shared run gate — the
 * ownership decision of spec 11 (D26), taken over an MSW `Request` and the
 * mock db's row and identity instead of over CE's `{ steps, request, user }`.
 *
 * Deliberately **not** a re-export of `../mcp/runGate`: parity only means
 * something when the two sides are written independently, which is the rule
 * `forkGate.ts` follows against `run/fork`'s `gate.fn.js`.
 * `runGate.fn.parity.test.ts` runs the generated `mcp-fn/runGate.fn.js` and
 * this side over one case table, so the two cannot drift with nothing to say
 * so.
 *
 * Pure: reads its arguments, touches no `db`. A handler in `handlers.ts` calls
 * it with the row it looked up, the request it was given, and `mockUser()`.
 */
import type { RunRow } from '../lib/runner/rows'
import type { MockUser } from './db'

/** How the driver asks (D28) — `workflow-headless` carries the nonce as a request header. */
export const DRIVE_KEY_HEADER = 'x-workflow-drive-key'

/** How a caller asks for all-scope where there is no query string to put it on. */
export const SCOPE_HEADER = 'x-workflow-scope'

/** The project roles that may widen the scope, once they ask (D27). */
const ALL_SCOPE_ROLES = ['owner', 'admin']

/**
 * `driveKey` (D28) is an additive column on `workflow_runs` that the row type
 * does not carry yet; the gate reads it, so the mock widens rather than
 * pretending the column is not there.
 */
export type GateRunRow = RunRow & { driveKey?: string }

/** CE gains `projectRole` on `PipelineUser` (spec 11 §Why `projectRole`); the mock identity widens the same way. */
export type GateUser = MockUser & { projectRole?: string }

/**
 * The gate, over the three signals the real one reads: who the row belongs to,
 * the drive nonce on the request, and an explicit ask for all-scope (query
 * string, header, or — once a handler has parsed the body — `opts.bodyScope`).
 *
 * `runless` is the caller saying this request names no run, so there is
 * nothing to gate. Anything else that is not admitted is *not found*, never
 * forbidden: a run id leaks nothing about whether it exists.
 */
export function mockGate(
  row: GateRunRow | undefined,
  request: Request,
  user: GateUser,
  opts: { runless?: boolean; bodyScope?: string } = {},
): { ok: boolean; door: string } {
  if (opts.runless === true) return { ok: true, door: 'runless' }
  if (!row) return { ok: false, door: '' }

  const callerId = typeof user?.id === 'string' ? user.id : ''
  const startedBy = typeof row.startedBy === 'string' ? row.startedBy : ''
  if (callerId !== '' && startedBy === callerId) return { ok: true, door: 'owner' }

  // Whatever the run's status: the driver reads the finished run it just
  // sealed, holding nothing but this nonce (apps#665 review).
  const sent = (request.headers.get(DRIVE_KEY_HEADER) ?? '').trim()
  const held = typeof row.driveKey === 'string' ? row.driveKey : ''
  if (sent !== '' && sent === held) return { ok: true, door: 'drive' }

  const asked =
    new URL(request.url).searchParams.get('scope') === 'all' ||
    opts.bodyScope === 'all' ||
    (request.headers.get(SCOPE_HEADER) ?? '').trim() === 'all'
  const role = typeof user?.projectRole === 'string' ? user.projectRole.toLowerCase() : ''
  if (asked && ALL_SCOPE_ROLES.includes(role)) return { ok: true, door: 'all' }

  // The fourth door, a `workflow_run_grants` row, is not built (spec 11).
  return { ok: false, door: '' }
}
