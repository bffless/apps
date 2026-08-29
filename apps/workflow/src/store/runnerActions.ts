/**
 * Kickoff (Phase 3): `startRun` opens the run slice and fires the run's first
 * event. Persistence and scheduling are the middleware's job (Task 17) — this
 * thunk only starts the run in memory and hands back its id so the caller can
 * navigate to it.
 */
import { newOwnerId, newRunId } from '../lib/runner/ids'
import type { Definition } from '../lib/runner/types'
import type { AppThunk } from './index'
import { runEvent, runOpened } from './runSlice'
import type { RunMeta } from './runSlice'

const OWNER_ID_KEY = 'workflow.ownerId'

/** One id per tab (the lease owner, 05), memoized in `sessionStorage`. */
export function getOwnerId(): string {
  const existing = sessionStorage.getItem(OWNER_ID_KEY)
  if (existing) return existing
  const id = newOwnerId()
  sessionStorage.setItem(OWNER_ID_KEY, id)
  return id
}

export interface StartRunArgs {
  impl: string
  /** The file base name minus `.workflow.yaml` (R1) — not the listing's `file`. */
  workflow: string
  def: Definition
  yaml: string
  workflowName: string
  workflowVersion?: string
  values: Record<string, unknown>
  /**
   * The run's own headless flag (07): `?auto=1` sets it, a person pressing
   * Start does not. It rides on `run.started` because every branch that reads
   * it — the `headless:` declarations, the wait budgets, the island's
   * `hostContext.bffless.headless` — reads it off `runState.headless`, and a
   * resumed run must see the same answer the run started with.
   */
  headless?: boolean
  /**
   * "Don't wait for me" (07): the kickoff form's own toggle. Rides on
   * `run.started` for the same reason `headless` does — `headlessDecision`,
   * the form auto-submit and the island's `hostContext.bffless.headless` all
   * read it off `runState`, and a resumed run must see what it started with.
   */
  unattended?: boolean
}

export function startRun(a: StartRunArgs): AppThunk<string> {
  return (dispatch) => {
    const runId = newRunId()

    const meta: RunMeta = {
      def: a.def,
      yaml: a.yaml,
      workflowName: a.workflowName,
      ...(a.workflowVersion === undefined ? {} : { workflowVersion: a.workflowVersion }),
    }
    dispatch(runOpened({ meta }))

    dispatch(
      runEvent({
        type: 'run.started',
        runId,
        impl: a.impl,
        workflow: a.workflow,
        inputs: a.values,
        headless: a.headless ?? false,
        unattended: a.unattended ?? false,
        at: Date.now(),
      }),
    )

    return runId
  }
}
