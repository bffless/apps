/**
 * The mock's re-implementation of `run/fork/post/gate.fn.js` — the whole access
 * and adoption decision of a fork, over the same three inputs the rule's three
 * `data_query` steps hand the real gate (the parent row, its step rows, any row
 * already wearing the new id). `forkGate.fn.parity.test.ts` runs the authored
 * `.fn.js` and this side by side over one case table, so the two cannot drift
 * with nothing to say so (the `analyze.ts` / `deleteGate` arrangement).
 *
 * Pure: reads its arguments, touches no `db`. The handler in `handlers.ts` does
 * the two writes the rule's `create` + `copy` steps do.
 */
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'

/** The roles the gate treats as "may fork anyone's run" — the delete gate's set. */
const ADMIN_ROLES = new Set(['admin', 'owner'])

/** `graph.ts` `TERMINAL_STEP`: a row the rule will copy as-is, whatever it says. */
const TERMINAL = new Set(['succeeded', 'failed', 'skipped', 'cancelled'])

/** A `workflow_run_steps` row as the `copy` step writes it: re-pointed, plus the dedup column. */
export type ForkedStepRow = StepRow & { rowKey: string }

export type ForkGateResult =
  | { status: 400 | 403 | 404 | 409; error: string }
  | { status: 200; createRun: boolean; run: RunRow; rows: ForkedStepRow[] }

export interface ForkGateInput {
  parent: ServerRunRow | null
  rows: ServerStepRow[]
  existing: ServerRunRow | null
  body: Record<string, unknown>
  user: { id?: string; role?: string } | undefined
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** `jobs.<j>.needs`, as authored: absent, one name, or a list. */
function needsOf(jobs: Record<string, unknown>, name: string): string[] {
  const job = jobs[name]
  const needs = isObj(job) ? job.needs : undefined
  return Array.isArray(needs) ? needs.map(String) : typeof needs === 'string' ? [needs] : []
}

/** The transitive closure of `job` over `needs`, `job` included — what the fork re-runs. */
function downstreamOf(jobs: Record<string, unknown>, job: string): Set<string> {
  const downstream = new Set([job])
  let grew = true
  while (grew) {
    grew = false
    for (const name of Object.keys(jobs)) {
      if (downstream.has(name)) continue
      if (needsOf(jobs, name).some((need) => downstream.has(need))) {
        downstream.add(name)
        grew = true
      }
    }
  }
  return downstream
}

/**
 * Is `row` still addressable in the sent definition: its job, its step id, and —
 * only where the step declares an `outputs` map — every output name it recorded?
 * A step with no map (a form, a bare pipeline step) is not output-checked.
 */
function stillDefined(jobs: Record<string, unknown>, row: StepRow): boolean {
  const job = jobs[row.job]
  if (!isObj(job)) return false
  const steps = Array.isArray(job.steps) ? job.steps : []
  const step = steps.find((s): s is Record<string, unknown> => isObj(s) && s.id === row.step)
  if (!step) return false
  if (isObj(step.outputs) && isObj(row.outputs)) {
    const declared = step.outputs
    return Object.keys(row.outputs).every((name) => Object.prototype.hasOwnProperty.call(declared, name))
  }
  return true
}

export function forkGate({ parent, rows, existing, body, user }: ForkGateInput): ForkGateResult {
  const id = typeof body.id === 'string' ? body.id : ''
  const from = typeof body.from === 'string' ? body.from : ''
  const job = typeof body.job === 'string' ? body.job : ''
  const definition = isObj(body.definition) ? body.definition : null
  if (!/^run_[0-9A-Za-z]+$/.test(id)) return { status: 400, error: 'id must be a run id' }
  if (!from || !job) return { status: 400, error: 'from and job are required' }
  if (id === from) return { status: 400, error: 'a run cannot be forked onto itself' }
  if (!definition || !isObj(definition.jobs) || typeof body.yaml !== 'string') {
    return { status: 400, error: 'definition and yaml are required' }
  }
  const sentJobs = definition.jobs

  if (!parent) return { status: 404, error: 'run not found' }
  const parentDef = isObj(parent.definition) ? parent.definition : {}
  const parentJobs = isObj(parentDef.jobs) ? parentDef.jobs : {}
  if (!isObj(parentJobs[job]) || !isObj(sentJobs[job])) return { status: 404, error: `job not found: ${job}` }
  if (parent.status === 'running') return { status: 409, error: 'cancel the run first' }
  const admin = ADMIN_ROLES.has(String(user?.role ?? '').toLowerCase())
  // `undefined !== undefined` is `false` — an id-less user must never fall
  // through that comparison just because a row with no `startedBy` is *also*
  // id-less (gate.fn.js's `!caller.id ||` guard, mirrored here).
  if (!admin && (!user?.id || parent.startedBy !== user.id)) {
    return { status: 403, error: 'only the run owner or an admin can fork a run' }
  }
  if (existing && (existing.forkedFrom !== from || existing.forkJob !== job)) {
    return { status: 409, error: 'run id already in use' }
  }

  const downstream = downstreamOf(parentJobs, job)
  const copies: ForkedStepRow[] = []
  for (const row of rows) {
    if (downstream.has(row.job)) continue
    if (!TERMINAL.has(row.status)) return { status: 409, error: `step ${row.key} has not finished` }
    if (!stillDefined(sentJobs, row)) return { status: 409, error: `definition changed: ${row.key}` }
    const { _id: _dropped, ...columns } = row
    void _dropped
    copies.push({ ...columns, runId: id, rowKey: `${id}/${row.key}` })
  }

  const now = Date.now()
  return {
    status: 200,
    createRun: !existing,
    run: {
      runId: id,
      impl: parent.impl,
      workflow: parent.workflow,
      workflowName: parent.workflowName,
      ...(typeof body.workflowVersion === 'string' ? { workflowVersion: body.workflowVersion } : {}),
      definition,
      yaml: body.yaml,
      inputs: parent.inputs,
      status: 'running',
      headless: false,
      unattended: body.unattended === true,
      ...(user?.id ? { startedBy: user.id } : {}),
      startedAt: now,
      leaseOwner: String(body.owner ?? ''),
      leaseUntil: now + 60_000,
      forkedFrom: from,
      forkJob: job,
    },
    rows: copies,
  }
}
