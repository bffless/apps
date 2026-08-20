/**
 * Resume (05): rebuild a `RunState` from the persisted rows.
 *
 * The rows are a *projection* of the event stream, not the stream itself — job
 * expansion is derived and per-attempt history is collapsed into one row. So
 * replay works the other way round: it turns each row back into the **shortest
 * legal event sequence** that lands the step on the recorded status, and folds
 * those events through the very same `runReducer` the live run uses. There is
 * one state machine, so a resumed run and a live one cannot drift.
 *
 * Two consequences worth knowing:
 * - every emitted sequence must satisfy `STEP_TRANSITIONS`, because the reducer
 *   asserts it; a row with `attempt: N` therefore replays as N-1
 *   `started → retrying` cycles (retry is only legal out of running/polling)
 *   before its final attempt;
 * - exactly one *creation* event (`step.queued` or `step.skipped`) is emitted
 *   per row — a second one on the same key is an illegal transition.
 *
 * Pure: no React/Redux/MSW/app imports (spec 09, enforced by eslint).
 */
import { buildJobContexts } from './contexts'
import { expandMatrix, isTerminal, jobOrder, jobResult } from './graph'
import { initialRunState, runReducer } from './reducer'
import type { RunRow, StepRow } from './rows'
import type { Definition, Job, RunEvent, RunState, StepError } from './types'

type Expansion = { total: number; items: Record<string, unknown>[] }

/** Declaration order of a step inside its job; unknown steps sort last. */
function stepPos(def: Definition, job: string, stepId: string): number {
  const i = def.jobs[job]?.steps.findIndex((s) => s.id === stepId) ?? -1
  return i < 0 ? Number.MAX_SAFE_INTEGER : i
}

function emptyItems(total: number): Record<string, unknown>[] {
  return Array.from({ length: total }, () => ({}))
}

/**
 * Re-derive `job.expanded` from the state rebuilt so far — the same call the
 * scheduler made when the run was live, against the same contexts, so it yields
 * the same fan-out. When the matrix cannot be evaluated (an upstream job is
 * still in flight, so its outputs are not there yet) the rows themselves are the
 * evidence: `1 + max(index)`.
 */
function deriveExpansion(
  def: Definition,
  state: RunState,
  job: Job,
  rows: StepRow[],
): Expansion | null {
  const needed = rows.length > 0 ? 1 + Math.max(...rows.map((r) => r.index)) : 0

  let expansion: Expansion | null
  try {
    expansion = expandMatrix(job, buildJobContexts(def, state, job.id))
  } catch {
    expansion = null
  }

  if (!expansion) {
    if (rows.length === 0) return null
    return { total: needed, items: emptyItems(needed) }
  }
  if (expansion.total < needed) {
    return {
      total: needed,
      items: [...expansion.items, ...emptyItems(needed - expansion.total)],
    }
  }
  return expansion
}

/** The events one step row implies, in a sequence the transition table permits. */
function eventsForRow(row: StepRow, fallbackAt: number): RunEvent[] {
  const key = row.key
  const startedAt = row.startedAt ?? fallbackAt
  const finishedAt = row.finishedAt ?? startedAt
  const inputs = (row.inputs ?? {}) as Record<string, unknown>
  const response = row.response as
    | { initial?: unknown; last?: unknown; truncated?: boolean }
    | undefined

  // A skipped step never entered the queue: its creation event *is* `step.skipped`.
  if (row.status === 'skipped') {
    return [
      {
        type: 'step.skipped',
        key,
        job: row.job,
        index: row.index,
        stepId: row.step,
        kind: row.kind,
        at: finishedAt,
      },
    ]
  }

  const events: RunEvent[] = [
    {
      type: 'step.queued',
      key,
      job: row.job,
      index: row.index,
      stepId: row.step,
      kind: row.kind,
      at: startedAt,
    },
  ]

  // Attempts are a counter, not a log: the row keeps only the last error, which
  // is also the one the reducer leaves on the step. One `started → retrying`
  // cycle per extra attempt reproduces both the counter and that error.
  const retryError: StepError = row.error ?? { code: 'retry', message: 'retried' }
  for (let attempt = 1; attempt < row.attempt; attempt++) {
    events.push({ type: 'step.started', key, inputs, at: startedAt })
    events.push({ type: 'step.retrying', key, error: retryError, at: startedAt })
  }

  // A retried step is back to `queued`; its recorded `startedAt` belongs to an
  // earlier attempt, so only the status decides whether it starts again.
  if (row.status === 'queued') return events

  if (row.startedAt != null || row.status === 'running' || row.status === 'polling') {
    events.push({ type: 'step.started', key, inputs, at: startedAt })
  } else if (row.status === 'succeeded' || row.status === 'failed') {
    // A form/island step that finished without ever running went through
    // `waiting` — `queued → succeeded` is not a legal transition.
    events.push({ type: 'step.waiting', key, at: startedAt })
  }

  switch (row.status) {
    case 'running':
      break
    case 'polling':
      events.push({ type: 'step.polling', key, initial: response?.initial, at: startedAt })
      break
    case 'waiting':
      events.push({ type: 'step.waiting', key, at: startedAt })
      break
    case 'succeeded':
      events.push({
        type: 'step.succeeded',
        key,
        outputs: (row.outputs ?? {}) as Record<string, unknown>,
        response,
        summary: row.summary ?? undefined,
        annotations: row.annotations ?? undefined,
        at: finishedAt,
      })
      break
    case 'failed':
      events.push({
        type: 'step.failed',
        key,
        error: row.error ?? { code: 'unknown', message: 'step failed' },
        annotations: row.annotations ?? undefined,
        at: finishedAt,
      })
      break
    case 'cancelled':
      events.push({ type: 'step.cancelled', key, at: finishedAt })
      break
  }
  return events
}

/**
 * The persisted rows as an event stream. Jobs are walked in scheduling order
 * (topo layer, then job id) so each job's matrix is re-derived against a state
 * that already contains everything upstream of it.
 */
export function rowsToEvents(run: RunRow, steps: StepRow[], def: Definition): RunEvent[] {
  const events: RunEvent[] = []
  let state = initialRunState({
    runId: run.runId,
    impl: run.impl,
    workflow: run.workflow,
    inputs: run.inputs,
    headless: run.headless,
    startedAt: run.startedAt,
  })

  const emit = (event: RunEvent): void => {
    events.push(event)
    state = runReducer(state, event)
  }

  emit({
    type: 'run.started',
    runId: run.runId,
    impl: run.impl,
    workflow: run.workflow,
    inputs: run.inputs,
    headless: run.headless,
    at: run.startedAt,
  })

  const byJob = new Map<string, StepRow[]>()
  for (const row of steps) {
    if (row.runId !== run.runId) continue
    const list = byJob.get(row.job)
    if (list) list.push(row)
    else byJob.set(row.job, [row])
  }

  for (const job of jobOrder(def)) {
    const decl = def.jobs[job]
    if (!decl) continue

    const rows = (byJob.get(job) ?? [])
      .slice()
      .sort((a, b) => a.index - b.index || stepPos(def, job, a.step) - stepPos(def, job, b.step))

    // A job with no rows was still expanded if the scheduler had reached it.
    const reached =
      rows.length > 0 || decl.needs.every((need) => isTerminal(jobResult(def, state, need)))
    if (!reached) continue

    const expansion = deriveExpansion(def, state, decl, rows)
    if (expansion) emit({ type: 'job.expanded', job, total: expansion.total, items: expansion.items })

    for (const row of rows) for (const event of eventsForRow(row, run.startedAt)) emit(event)
  }

  const at = run.finishedAt ?? run.startedAt
  for (const annotation of run.annotations ?? []) emit({ type: 'run.annotation', annotation, at })
  if (run.status !== 'running') {
    emit({ type: 'run.finished', status: run.status, outputs: run.outputs ?? undefined, at })
  }

  return events
}

/**
 * Rebuild the run state from its rows. `startedBy` is a run-row column that the
 * `run.started` event does not carry, so it is stamped onto the reduced state
 * rather than reached through the reducer.
 *
 * NOTE (controller ruling, Task 9): stamping it *after* the fold is deliberate —
 * it keeps replay's expression contexts identical to the live run's, which also
 * derived its matrices with `run.started_by` absent. If `startedBy` is ever
 * seeded into `initialRunState` at kickoff, or carried on `run.started`, then
 * `rowsToEvents` must seed it into its internal fold **in the same commit**:
 * otherwise a `strategy.matrix` or job `if` that reads `run.started_by` would
 * expand one way live and another way on Resume.
 */
export function replayRun(run: RunRow, steps: StepRow[], def: Definition): RunState {
  const state = rowsToEvents(run, steps, def).reduce(
    runReducer,
    initialRunState({
      runId: run.runId,
      impl: run.impl,
      workflow: run.workflow,
      inputs: run.inputs,
      headless: run.headless,
      startedAt: run.startedAt,
    }),
  )
  return run.startedBy === undefined ? state : { ...state, startedBy: run.startedBy }
}
