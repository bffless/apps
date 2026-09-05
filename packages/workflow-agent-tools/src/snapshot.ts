/**
 * The run snapshot (spec 10): the `window.__workflow` shape (07) extended with
 * `waitingOn` — for each `waiting` step, its key, kind, the declared
 * inputs/outputs and, for islands, the `src`. It tells an agent not just *that*
 * the run is waiting but *what would satisfy it*: the machine equivalent of
 * the step pane.
 *
 * `snapshotFromRows` is the derivation both adapters share (D19): a run row plus
 * its step rows — what `/api/workflow/run` answers and what the MCP endpoint
 * will read server-side — into a snapshot. The harness page has a richer source
 * for the run it is driving (the live state and the resolved island URL), and
 * derives that one itself; the shape is this one either way.
 */
export type StepStatus =
  | 'queued'
  | 'running'
  | 'polling'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

/** A step a driver (or an agent) should still be waiting on — the same set `window.__workflow.currentSteps` uses (07). */
export const ACTIVE_STEP_STATUSES: ReadonlySet<string> = new Set(['running', 'polling', 'waiting'])

export interface WaitingStep {
  key: string
  kind: 'form' | 'island'
  /** A form's evaluated `with` (title, `fields` with defaults/options resolved, submit); an island's tool arguments. */
  inputs: Record<string, unknown>
  /** The step's declared output map (islands). A form's outputs are its fields, already in `inputs.fields`. */
  outputs?: Record<string, unknown>
  /** Islands only: the resolved iframe URL when the deriving surface knows it, else the declared `with.src`. */
  src?: string
}

export interface RunSnapshot {
  /** `''` when a start was refused before a run existed (`status: 'invalid'`). */
  runId: string
  /**
   * `invalid`: no run was started (a refused start).
   * `pending`: dispatched over the endpoint, no row yet — ADR-0006. A driven
   * run exists as an id before its job writes the first row (about a minute),
   * and a caller that is told nothing at all would read that gap as failure.
   */
  status: RunStatus | 'invalid' | 'pending'
  /** Keys of the steps that are `running`, `polling` or `waiting` right now. */
  currentSteps: string[]
  /** The run's top-level outputs — File refs, never bytes. */
  outputs: Record<string, unknown>
  steps: Record<string, StepStatus>
  /** Only on `invalid`: why the start was refused, keyed as spec 07 keys them. */
  errors?: Record<string, string>
  waitingOn: WaitingStep[]
}

/** The run row, structurally — what `GET /api/workflow/run` answers as `run`. */
export interface RunRowLike {
  runId: string
  status: string
  outputs?: unknown
  /** The workflow definition snapshot the row carries (D16) — raw JSON, not a typed model. */
  definition?: unknown
}

/** One step row, structurally — `GET /api/workflow/run`'s `steps[]`. */
export interface StepRowLike {
  key: string
  job: string
  step: string
  kind: string
  status: string
  inputs?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRunStatus(value: string): value is RunStatus {
  return value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled'
}

/** The raw step declaration for (job, stepId) in a definition snapshot, or `undefined`. */
function declaredStep(definition: unknown, job: string, stepId: string): Record<string, unknown> | undefined {
  if (!isPlainObject(definition) || !isPlainObject(definition.jobs)) return undefined
  const jobDecl = definition.jobs[job]
  if (!isPlainObject(jobDecl) || !Array.isArray(jobDecl.steps)) return undefined
  return jobDecl.steps.find((step): step is Record<string, unknown> => isPlainObject(step) && step.id === stepId)
}

/**
 * A snapshot of a run read as rows. `status` outside the persisted vocabulary
 * (a row from a future column) is passed through as-is rather than guessed at.
 */
export function snapshotFromRows(run: RunRowLike, steps: StepRowLike[]): RunSnapshot {
  const stepStatuses: Record<string, StepStatus> = {}
  const currentSteps: string[] = []
  const waitingOn: WaitingStep[] = []

  for (const row of steps) {
    stepStatuses[row.key] = row.status as StepStatus
    if (ACTIVE_STEP_STATUSES.has(row.status)) currentSteps.push(row.key)
    if (row.status !== 'waiting' || (row.kind !== 'form' && row.kind !== 'island')) continue

    const decl = declaredStep(run.definition, row.job, row.step)
    const withDecl = decl && isPlainObject(decl.with) ? decl.with : undefined
    const waiting: WaitingStep = {
      key: row.key,
      kind: row.kind,
      inputs: isPlainObject(row.inputs) ? row.inputs : {},
    }
    if (row.kind === 'island') {
      if (decl && isPlainObject(decl.outputs)) waiting.outputs = decl.outputs
      if (withDecl && typeof withDecl.src === 'string') waiting.src = withDecl.src
    }
    waitingOn.push(waiting)
  }

  return {
    runId: run.runId,
    status: isRunStatus(run.status) ? run.status : (run.status as RunStatus),
    currentSteps,
    outputs: isPlainObject(run.outputs) ? run.outputs : {},
    steps: stepStatuses,
    waitingOn,
  }
}

/**
 * `name (type[, required])` per declaration — an island's `outputs` map or a
 * form's `fields` — so a reader that only sees the text (an agent host shows
 * a model `content[0].text` and nothing else) still learns what would satisfy
 * the step. An untyped island output is `json`, an untyped form field `string` (02).
 */
export function declaredList(decls: unknown, defaultType: string): string {
  if (!isPlainObject(decls)) return ''
  return Object.entries(decls)
    .map(([name, declared]) => {
      const decl = isPlainObject(declared) ? declared : {}
      const type = typeof decl.type === 'string' ? decl.type : defaultType
      const list = decl.list === true ? '[]' : ''
      return `${name} (${type}${list}${decl.required === true ? ', required' : ''})`
    })
    .join(', ')
}

function describeStep(step: WaitingStep): string {
  const detail =
    step.kind === 'island'
      ? declaredList(step.outputs, 'json')
      : declaredList(isPlainObject(step.inputs) ? step.inputs.fields : undefined, 'string')
  if (detail === '') return `${step.key} (${step.kind})`
  return `${step.key} (${step.kind}; ${step.kind === 'island' ? 'outputs' : 'fields'}: ${detail})`
}

function describeWaiting(snapshot: RunSnapshot): string {
  if (snapshot.waitingOn.length === 0) return ''
  return `, waiting on ${snapshot.waitingOn.map(describeStep).join(', ')}`
}

/**
 * The one sentence both adapters say about a snapshot — "Run <id> is
 * <status>, waiting on <key> (<kind>)" — so a model hears the same thing from
 * the harness page and from the MCP endpoint (D19).
 */
export function snapshotText(snapshot: RunSnapshot): string {
  if (snapshot.status === 'invalid') return 'No run was started'
  // A pending run has nothing to report but its own existence: no steps have
  // been written, so `waitingOn` would say "waiting on nothing" if it spoke.
  if (snapshot.status === 'pending') return `Run ${snapshot.runId} is pending — dispatched, not started yet`
  return `Run ${snapshot.runId} is ${snapshot.status}${describeWaiting(snapshot)}`
}
