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
  /**
   * The run's top-level outputs — File refs, never bytes. Pass a ref's `path`
   * to `workflow.sign` for a fetchable URL; the ref's own `url` is the harness
   * page's session-only path (apps#627).
   */
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
 * What the endpoint knows about a run it is still calling `pending` and the
 * caller cannot: how long ago the id was minted, and the instant the answer
 * becomes `No such run` (apps#653). An agent host has no clock and no sleep
 * between tool calls, so a pending answer naming neither leaves the caller
 * counting polls — twelve inside 25s once read as failure on a healthy run.
 */
export interface PendingTiming {
  /** Milliseconds since the run id was minted. A negative value (clock skew) reads as 0. */
  elapsedMs: number
  /** The ms instant after which the id stops reading `pending` and reads `No such run`. */
  pendingUntil: number
}

/** Whole seconds, never negative — `9s`, `312s`: seconds throughout the window, so two answers subtract. */
function elapsedSeconds(elapsedMs: number): string {
  return `${Math.floor(Math.max(0, elapsedMs) / 1000)}s`
}

/** An instant to the second a later answer can be compared against: `2026-09-09T15:16:57Z`. */
function instant(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`
}

/**
 * The one sentence both adapters say about a snapshot — "Run <id> is
 * <status>, waiting on <key> (<kind>)" — so a model hears the same thing from
 * the harness page and from the MCP endpoint (D19). `pending` alone takes a
 * second argument, because only the endpoint mints a pending snapshot and only
 * it holds the clock that sentence needs; the page adapter never reaches it.
 */
export function snapshotText(snapshot: RunSnapshot, pending?: PendingTiming): string {
  if (snapshot.status === 'invalid') return 'No run was started'
  // A pending run has nothing to report but its own existence: no steps have
  // been written, so `waitingOn` would say "waiting on nothing" if it spoke.
  // What it can report, given the endpoint's clock, is how long it has been.
  if (snapshot.status === 'pending') {
    if (pending === undefined) return `Run ${snapshot.runId} is pending — dispatched, not started yet`
    return (
      `Run ${snapshot.runId} is pending — dispatched ${elapsedSeconds(pending.elapsedMs)} ago, not started yet.` +
      ` The first row usually appears about 60s in. Pending until ${instant(pending.pendingUntil)}, then` +
      ` \`No such run: ${snapshot.runId}\` — that answer, not your poll count, is how a dispatch is failed`
    )
  }
  return `Run ${snapshot.runId} is ${snapshot.status}${describeWaiting(snapshot)}`
}

/**
 * A File ref by the loose reading apps/workflow's `isFileRefLike` uses (spec
 * 02): `path`, `name` and `url` all strings. `path` alone is not enough — a
 * pipeline's JSON output can carry a `path` key and not be a file.
 */
function isFileRefLike(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && typeof value.path === 'string' && typeof value.name === 'string' && typeof value.url === 'string'
}

/**
 * A human-readable size — `B` under 1 KB (no decimal), `KB`/`MB`/`GB` above it
 * (one decimal): `512` → `512 B`, `1024` → `1.0 KB`, `7215671` → `6.9 MB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** `- <label>: <name> (<size>, <contentType>) — path: <path>`, either parenthetical part omitted when the ref lacks it. */
function refLine(label: string, ref: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof ref.size === 'number') parts.push(formatBytes(ref.size))
  if (typeof ref.contentType === 'string') parts.push(ref.contentType)
  const paren = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `- ${label}: ${String(ref.name)}${paren} — path: ${String(ref.path)}`
}

/**
 * One line per File ref in `outputs` — a bare ref as `<key>`, a ref inside a
 * `list` output as `<key>[<i>]` (non-ref entries skipped) — in `Object.keys`
 * / array order. Never touches a non-ref output's value (apps#627: a `words`
 * array can be thousands of entries).
 */
function fileRefLines(outputs: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(outputs)) {
    if (isFileRefLike(value)) {
      lines.push(refLine(key, value))
      continue
    }
    if (!Array.isArray(value)) continue
    value.forEach((entry, i) => {
      if (isFileRefLike(entry)) lines.push(refLine(`${key}[${i}]`, entry))
    })
  }
  return lines
}

/**
 * The sentence `workflow.outputs` adds when an output is a File ref (apps#627):
 * a caller without the harness page's session — an agent over the MCP
 * endpoint — cannot fetch a ref's `url`, and nothing else it reads after the
 * call says which door to use. The descriptions in `catalog.ts` say the same.
 */
export const FILE_REF_HINT =
  'File refs, never bytes — pass a ref’s `path` to workflow.sign for a fetchable URL; the ref’s own `url` is the harness page’s session-only path.'

/**
 * The one sentence both adapters say about a run's outputs — "Run <id>
 * (<status>) outputs: <keys>", one line per File ref (name, size, type, path;
 * a `words`-shaped output never gets its value dumped) and `FILE_REF_HINT`
 * when any output is a ref — so a text-only host (Claude.ai/Desktop, which
 * sees only this text, not `structuredContent`) has everything it needs to
 * exchange a ref for a URL (apps#627, apps#630/apps#631 desktop reports).
 */
export function outputsText(snapshot: Pick<RunSnapshot, 'runId' | 'status' | 'outputs'>): string {
  const names = Object.keys(snapshot.outputs)
  if (names.length === 0) return `Run ${snapshot.runId} is ${snapshot.status} and has no outputs${snapshot.status === 'running' ? ' yet' : ''}`
  const line = `Run ${snapshot.runId} (${snapshot.status}) outputs: ${names.join(', ')}`
  const refLines = fileRefLines(snapshot.outputs)
  return refLines.length === 0 ? line : [line, ...refLines, FILE_REF_HINT].join('\n')
}
