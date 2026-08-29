/**
 * Delete, as the run page offers it (05 retention, Task 20).
 *
 * Three things travel together and only make sense together: whether the
 * button may be shown at all, whether a deletion is in flight, and what the
 * server said when it refused. They were inlined in `RunPage.tsx` — the page
 * that also owns the URL selection, the live/replayed split and three levels of
 * pane — so they are lifted here, where they can be read in one screenful
 * (apps#382).
 *
 * What stays with the page is where to go afterwards: this hook has no router,
 * and a hook that navigated would be deciding what the page after the deletion
 * is. It calls `onDeleted` and stops.
 *
 * The gate is advisory. `canDelete` mirrors the rule's own check so the button
 * is only offered where the answer is likely yes; the rule re-reads `user.*`
 * server-side, so the worst a wrong answer here can do is offer a button the
 * server then refuses — which is a normal outcome, and `failed` is where it
 * lands.
 */
import { useState } from 'react'
import { RunStoreError } from '../lib/runStore'
import { deleteRun } from './lifecycleActions'
import { useAppDispatch } from './hooks'
import { useWhoamiQuery } from './workflowApi'

/** The roles the delete rule lets past its owner check (05 access) — mirrored, never trusted. */
const ADMIN_ROLES = ['admin', 'owner']

/**
 * A refusal from the delete rule, in the words of the person who asked. The
 * three statuses mean three different things and only one of them is "try
 * again", so a single "couldn't delete" message would hide the fix.
 */
export function deleteMessage(error: unknown): string {
  if (error instanceof RunStoreError) {
    if (error.status === 403) return "Only the run's owner or an admin can delete it."
    if (error.status === 409) return 'Cancel the run first, then delete it.'
    if (error.status === 404) return 'This run is already gone.'
  }
  return error instanceof Error ? error.message : 'The run could not be deleted.'
}

export interface RunDeleteFacts {
  /** The run on screen; `undefined` until the page knows which one it is. */
  runId?: string
  /** Its status — a run still going cannot be deleted, only cancelled. */
  status?: string
  /** The session that started it, when the record names one. */
  startedBy?: string
  /** Where the page goes once the run is gone. */
  onDeleted: () => void
}

export interface RunDelete {
  /** The header's `onDelete`: `undefined` means "do not offer it at all". */
  onDelete?: () => void
  /** A deletion is in flight — the button says so and stops taking clicks. */
  deleting: boolean
  /** The refusal to show, in the words of the person who asked; `null` while there is none. */
  failed: string | null
}

export function useRunDelete({ runId, status, startedBy, onDeleted }: RunDeleteFacts): RunDelete {
  const dispatch = useAppDispatch()
  const { data: me } = useWhoamiQuery()
  const [deleting, setDeleting] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const allowed =
    runId !== undefined &&
    status !== undefined &&
    status !== 'running' &&
    me !== undefined &&
    (startedBy === me.id || ADMIN_ROLES.includes((me.role ?? '').toLowerCase()))

  async function remove(id: string) {
    setDeleting(true)
    setFailed(null)
    try {
      await dispatch(deleteRun({ runId: id }))
      // Only on success, and only here: the thunk owns the caches, the caller
      // owns where to go next (there is no run left to be on).
      onDeleted()
    } catch (error) {
      // Deliberately not in a `finally`: the success path has navigated away
      // and this component is gone, so re-enabling the button is the failure
      // path's business alone.
      setFailed(deleteMessage(error))
      setDeleting(false)
    }
  }

  return {
    onDelete: allowed ? () => void remove(runId) : undefined,
    deleting,
    failed,
  }
}
