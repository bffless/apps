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
        headless: false,
        at: Date.now(),
      }),
    )

    return runId
  }
}
