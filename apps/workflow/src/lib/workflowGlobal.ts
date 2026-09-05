/**
 * `window.__workflow` (07/D12) — the one thing on the page a headless driver
 * reads to follow a run.
 *
 * It is a **contract**, in the same sense the `data-testid`s are: the driver
 * polls it between navigations and decides from it when to stop waiting, so
 * its shape may not drift with whatever the page happens to be rendering.
 * Hence this module — one writer, one type, one place to change it — rather
 * than an object literal assembled inside a component.
 *
 * `invalid` is a *page* state, not a run status: a `?auto=1` start the kickoff
 * page refused never produced a run at all (there is no row, and `runId` is
 * empty). It is deliberately absent from `RunStatus`, which is persisted.
 * `parked` and `busy` (07 `wait=park`) are page states of the same kind: the
 * run behind them is a perfectly ordinary `running` row, and what they report
 * is what *this page* is doing about it — nothing, and waiting for a person.
 */
import type { RunState, RunStatus, StepKey, StepStatus } from './runner/types'

export interface WorkflowGlobal {
  /** The run this page is showing; `''` when a start was refused before a run existed. */
  runId: string
  /** `parked` and `busy` are page states like `invalid`: no row ever carries them (07). */
  status: RunStatus | 'invalid' | 'parked' | 'busy'
  /** Keys of the steps that are `running`, `polling` or `waiting` right now. */
  currentSteps: StepKey[]
  /** The run's top-level outputs — filled at completion (File refs, not bytes). */
  outputs: Record<string, unknown>
  steps: Record<StepKey, StepStatus>
  /**
   * Only on `invalid`: why the start was refused. Keyed by the input that
   * failed — or, for a refusal no single input is to blame for, by the part of
   * the start that did: `inputs` (the parameter would not decode), `workflow`
   * (no such workflow, its file could not be read, or it does not lint),
   * `discovery` (the implementations could not be listed).
   */
  errors?: Record<string, string>
}

declare global {
  interface Window {
    __workflow?: WorkflowGlobal
  }
}

/**
 * What `snapshotOf` produces: the same contract, narrowed to the run's **own**
 * status. The page states (`parked`, `busy`) are only ever put on top of one of
 * these by `withPageState`, so anything reading a snapshot straight off a
 * `RunState` — `runSnapshotOf` (agent/snapshot.ts) and the `RunSnapshot` the
 * agent tools declare — still sees the persisted statuses and nothing else.
 */
export type RunGlobal = WorkflowGlobal & { status: RunStatus }

/** A step a driver should still be waiting on. */
const ACTIVE: ReadonlySet<StepStatus> = new Set<StepStatus>(['running', 'polling', 'waiting'])

/** The run, as the contract describes it. */
export function snapshotOf(state: RunState): RunGlobal {
  const steps: Record<StepKey, StepStatus> = {}
  const currentSteps: StepKey[] = []
  for (const [key, step] of Object.entries(state.steps)) {
    steps[key] = step.status
    if (ACTIVE.has(step.status)) currentSteps.push(key)
  }
  return {
    runId: state.runId,
    status: state.status,
    currentSteps,
    outputs: state.outputs ?? {},
    steps,
  }
}

/** The run, with the page's own state on top of the record's (07: `parked`, `busy` are page states). */
export function withPageState(snapshot: WorkflowGlobal, pageState: 'parked' | 'busy' | null): WorkflowGlobal {
  return pageState === null ? snapshot : { ...snapshot, status: pageState }
}

/**
 * Publish, or (on `null`) take it away. Cleared rather than frozen when the
 * page goes: a stale snapshot is worse than none — a driver reading one would
 * report on a run the page is no longer showing.
 */
export function publishWorkflowGlobal(snapshot: WorkflowGlobal | null): void {
  if (typeof window === 'undefined') return
  if (snapshot === null) delete window.__workflow
  else window.__workflow = snapshot
}
