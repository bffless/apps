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
 */
import type { RunState, RunStatus, StepKey, StepStatus } from './runner/types'

export interface WorkflowGlobal {
  /** The run this page is showing; `''` when a start was refused before a run existed. */
  runId: string
  status: RunStatus | 'invalid'
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

/** A step a driver should still be waiting on. */
const ACTIVE: ReadonlySet<StepStatus> = new Set<StepStatus>(['running', 'polling', 'waiting'])

/** The run, as the contract describes it. */
export function snapshotOf(state: RunState): WorkflowGlobal {
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
