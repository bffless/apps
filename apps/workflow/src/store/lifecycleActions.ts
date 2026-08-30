/**
 * Run lifecycle actions (Task 19): the ways out of a run once it exists —
 * Cancel (this tab, live) and Resume/Take-over (adopting a `running` row
 * this tab does not already hold). Re-run (08) is already the kickoff form's
 * `?from=` query param (Task 16, `KickoffPage.tsx`) — nothing to add here.
 *
 * `openRun`/`takeOver` build their own `RunStore` against the app's real HTTP
 * client, the same way `runnerActions.ts`'s `getOwnerId()` reaches straight
 * for `sessionStorage`: the lease/adopt handshake is a one-shot request this
 * thunk owns outright, not a step the runner middleware schedules. Once
 * adoption succeeds (`runReplaced({ mode: 'live' })`), everything that
 * follows — relaunching the run's non-terminal steps, the heartbeat — runs
 * *inside* the middleware itself, off the `deps` it was already constructed
 * with (`runnerMiddleware.ts`'s own `runReplaced` listener). That matters for
 * tests: relaunching a resumed step from *here* against a separately
 * constructed `RunnerDeps` would silently run it against the real clock
 * instead of a test's virtual one.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { httpJsonWithReauth } from '../lib/http'
import { newRunId } from '../lib/runner/ids'
import { replayRun } from '../lib/runner/replay'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, StepStatus } from '../lib/runner/types'
import { createRunStore } from '../lib/runStore'
import type { RunDeleter, RunForker, RunStore } from '../lib/runStore'
import type { AppThunk, RootState } from './index'
import { runnerControllers } from './runnerMiddleware'
import { getOwnerId } from './runnerActions'
import { runClosed, runEvent, runOpened, runReplaced } from './runSlice'
import type { RunMeta } from './runSlice'
import { workflowApi } from './workflowApi'

/** The app's real `RunStore` — fresh per module, matching `defaultRunnerDeps()` (store/index.ts). */
const runStore: RunStore & RunDeleter & RunForker = createRunStore(httpJsonWithReauth)

const NON_TERMINAL_STEP: ReadonlySet<StepStatus> = new Set(['queued', 'running', 'polling', 'waiting'])

const CANCEL_NOTICE = 'Run cancelled — server-side pipeline jobs already enqueued keep running.'

/**
 * Cancel (01): abort every controller this tab holds, mark each non-terminal
 * step cancelled, note it when a pipeline step was actually in flight (its
 * server-side job cannot be killed from here), then finish the run
 * `cancelled`. The middleware persists each dispatch as it lands (rows.ts).
 */
export function cancelRun(): AppThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const state = getState().run.state
    if (!state || state.status !== 'running') return

    runnerControllers.abortAll()

    const at = Date.now()
    let pipelineInFlight = false
    for (const step of Object.values(state.steps)) {
      if (!NON_TERMINAL_STEP.has(step.status)) continue
      if (step.kind === 'pipeline' && (step.status === 'running' || step.status === 'polling')) {
        pipelineInFlight = true
      }
      dispatch(runEvent({ type: 'step.cancelled', key: step.key, at }))
    }

    if (pipelineInFlight) {
      dispatch(
        runEvent({
          type: 'run.annotation',
          annotation: { level: 'notice', message: CANCEL_NOTICE },
          at,
        }),
      )
    }

    dispatch(runEvent({ type: 'run.finished', status: 'cancelled', at }))
  }
}

function metaFrom(run: RunRow, def: Definition): RunMeta {
  return {
    def,
    yaml: run.yaml,
    workflowName: run.workflowName,
    ...(run.workflowVersion === undefined ? {} : { workflowVersion: run.workflowVersion }),
    ...(run.forkedFrom && run.forkJob ? { forkedFrom: { runId: run.forkedFrom, job: run.forkJob } } : {}),
  }
}

/**
 * In-flight guard (fix round 1, finding 1): `openRun`/`takeOver` have no
 * disabled-while-pending affordance of their own (the caller — `RunPage.tsx`
 * — adds one too, but a thunk shouldn't depend on its caller for
 * correctness). Without this, two adopt attempts fired close together for
 * the *same* run (a double click, or a stale click landing after a first
 * attempt already resolved but before its UI re-render disables the
 * button) would both reach `runStore.lease` and, since the lease is granted
 * again to the same owner, both succeed — the second's `runReplaced`
 * supersedes the first mid-flight (see `runnerMiddleware.ts`'s generation
 * counter for what makes that safe *once it happens*; this just stops the
 * pointless double adoption in the common case where the two calls are
 * genuinely concurrent, not merely close together).
 */
const adopting = new Set<string>()

/**
 * Thrown by `adopt()` when the lease *request* itself fails — a network
 * error or a non-2xx answer from `runStore.lease` — as opposed to a normal
 * `{ ok: false }` response, which just means someone else genuinely holds
 * the lease (fix round 3, finding 3). `RunPage.tsx`'s `ResumeBanner` catches
 * this specifically so it can say "couldn't reach the server" instead of the
 * misleading "still held elsewhere," which is what an unhandled rejection
 * from here used to leave the UI implying.
 */
export class LeaseTransportError extends Error {}

/** The shared adopt-live-or-fall-back-readonly path behind `openRun`/`takeOver` (05 Resume). */
async function adopt(
  a: { runId: string; run: RunRow; steps: StepRow[] },
  dispatch: (action: unknown) => unknown,
  getState: () => RootState,
  takeover: boolean,
): Promise<void> {
  if (adopting.has(a.runId)) return
  adopting.add(a.runId)
  try {
    const def = toDefinition(a.run.definition) as Definition
    const state = replayRun(a.run, a.steps, def)
    const owner = getOwnerId()
    let l: { ok: boolean; leaseUntil?: number; heldBy?: string }
    try {
      l = await runStore.lease(a.runId, owner, takeover)
    } catch (err) {
      throw new LeaseTransportError(err instanceof Error ? err.message : String(err))
    }

    if (l.ok) {
      dispatch(runOpened({ meta: metaFrom(a.run, def) }))
      dispatch(runReplaced({ state, mode: 'live' }))
      return
    }

    // Rule (fix round 1, finding 2): a lost lease attempt must never clobber
    // a DIFFERENT run this tab is actively driving. `run` in the slice is
    // singular (one run's state per tab) — dispatching `runReplaced` here
    // unconditionally would overwrite it with *this* run's read-only replay,
    // flipping the actually-live run's own page to "not live" the moment
    // anything re-renders off the slice, on top of the teardown
    // `runnerMiddleware.ts`'s own guard prevents at the effect level. If
    // nothing else is live, or this failed attempt was for the SAME run
    // already live (a lease this tab itself just lost, e.g. a missed
    // heartbeat), the dispatch is safe and still lands so the read-only view
    // has fresh replayed state to show.
    const current = getState().run
    if (current.mode === 'live' && current.state && current.state.runId !== a.runId) return
    dispatch(runReplaced({ state, mode: 'readonly' }))
  } finally {
    adopting.delete(a.runId)
  }
}

/**
 * The RunPage entry point for a `running` row this tab does not hold: try to
 * take the lease outright. Granted → adopt live (the middleware's own
 * `runReplaced` listener relaunches the run's non-terminal steps and
 * restarts the heartbeat). Held by someone else → readonly, same as before
 * the attempt — the caller shows Take over.
 */
export function openRun(a: { runId: string; run: RunRow; steps: StepRow[] }): AppThunk<Promise<void>> {
  return async (dispatch, getState) => {
    await adopt(a, dispatch, getState, false)
  }
}

/** Force the lease away from whoever holds it, then the same adopt-live path as `openRun`. */
export function takeOver(a: { runId: string; run: RunRow; steps: StepRow[] }): AppThunk<Promise<void>> {
  return async (dispatch, getState) => {
    await adopt(a, dispatch, getState, true)
  }
}

/**
 * Retry, from the persistence-pause banner (05: "the run is paused with an
 * error banner"; apps#375). The pause means a write-ahead write failed —
 * the slice folded an event the record never got, and every in-flight
 * controller was aborted with it — or a resume was refused because a
 * recorded payload could not be read (`RESUME_REFUSED`). Both have the same
 * honest way forward: the **record** is the truth, so the run is re-read from
 * the server and adopted again through the very path a fresh tab would use
 * (`takeOver`, since this tab is the lease holder it is taking over from):
 * the replaced state drops whatever the record never got, the middleware's
 * `runReplaced` listener relaunches the steps left non-terminal, re-fetches
 * any `{"$file"}` payload (a failed read is never memoized), and clears
 * `paused`. If the record still cannot be read, or the payload still cannot,
 * the banner comes straight back with the reason.
 *
 * Throws `LeaseTransportError` when the record itself could not be read, so
 * the banner can say "couldn't reach the server" rather than pretending the
 * retry happened.
 */
export function retryRun(): AppThunk<Promise<void>> {
  return async (dispatch, getState) => {
    const runId = getState().run.state?.runId
    if (!runId) return
    const read = dispatch(workflowApi.endpoints.getRun.initiate(runId, { forceRefetch: true }))
    try {
      const res = await read
      if (res.error || !res.data?.run) {
        throw new LeaseTransportError(
          res.error ? `the run record could not be read (${JSON.stringify(res.error)})` : 'the run record is gone',
        )
      }
      await adopt({ runId, run: res.data.run, steps: res.data.steps }, dispatch, getState, true)
    } finally {
      read.unsubscribe()
    }
  }
}

/**
 * Fork — "Re-run from this job" (05; apps#491). A fork is a **new run**: the
 * `run/fork` rule (apps#501) creates its row and copies every step row of the
 * parent that is *not* downstream of `job` under the new id, in one request.
 * The new record is then adopted through the very path Resume uses, so the
 * middleware's `runReplaced` listener relaunches nothing (every copied row is
 * terminal) and the scheduler starts exactly the jobs whose `needs` are met
 * and which have no state yet — `job` and its dependents. The copied jobs'
 * outputs feed those expressions as they did in the parent.
 *
 * `owner: getOwnerId()` is load-bearing: the rule takes the lease *for* the
 * sender, and `adopt(…, takeover = false)` is then granted because the lease
 * is already ours. Whether `job` is a sensible fork point is the caller's
 * question (`forkTarget`, graph.ts); the rule's own gate answers with a
 * `RunStoreError` carrying its status and reason, rethrown as-is.
 *
 * Resolves to the new run id; navigating to it is the caller's job, as after
 * `deleteRun`. Throws `LeaseTransportError` when the freshly written record
 * cannot be read back. The `Runs` invalidation is the same one `deleteRun`
 * makes: the row was written by the rule, not by `run.started`, so nothing
 * else tells the Past-runs list a new run exists.
 */
export function forkRun(a: {
  runId: string
  job: string
  def: Definition
  yaml: string
  workflowVersion?: string
  unattended?: boolean
}): AppThunk<Promise<string>> {
  return async (dispatch, getState) => {
    const id = newRunId()
    await runStore.fork({
      id,
      from: a.runId,
      job: a.job,
      definition: a.def.raw,
      yaml: a.yaml,
      ...(a.workflowVersion === undefined ? {} : { workflowVersion: a.workflowVersion }),
      owner: getOwnerId(),
      unattended: a.unattended === true,
    })
    const read = dispatch(workflowApi.endpoints.getRun.initiate(id, { forceRefetch: true }))
    try {
      const res = await read
      if (res.error || !res.data?.run) {
        throw new LeaseTransportError(
          res.error
            ? `the forked run could not be read back (${JSON.stringify(res.error)})`
            : 'the forked run is gone',
        )
      }
      await adopt({ runId: id, run: res.data.run, steps: res.data.steps }, dispatch, getState, false)
    } finally {
      read.unsubscribe()
    }
    dispatch(workflowApi.util.invalidateTags(['Runs']))
    return id
  }
}

/**
 * Delete one run and everything it left behind (05 retention): the rule drops
 * the run's storage prefix, its `workflow_files` rows, its step rows and the
 * run row, in that order, behind its own 404/409/403 gate.
 *
 * The gate is the *server's* — this thunk asks and reports. `RunPage.tsx` only
 * offers the button when the answer is likely to be yes (a terminal run, owned
 * or admin), but a refusal is a normal outcome and is rethrown as the
 * `RunStoreError` it arrived as, status and all, so the page can say which of
 * the three refusals it was rather than "something went wrong".
 *
 * Navigating away is the **caller's** job: this module has no router, and a
 * thunk that redirected would be deciding what the page after the deletion is.
 * What it does own is the state the deleted run leaves behind — the run slice,
 * if this tab was showing it, and the list the row was in.
 *
 * Only `Runs`: the run's *own* cache entry is deliberately left alone
 * (apps#382). Invalidating `{ type: 'Run', id }` refetched the row the caller
 * is still on — it is only navigating away in the next tick — and that read
 * comes back `{ run: null }`, so the run page flashed "No such run" on its way
 * out. The entry needs no eviction: nothing subscribes to it once the page
 * unmounts, and RTK Query drops an unsubscribed entry by itself.
 */
export function deleteRun(a: { runId: string }): AppThunk<Promise<void>> {
  return async (dispatch, getState) => {
    await runStore.deleteRun(a.runId)
    // Only ever the run *this* tab holds: `runClosed` resets the slice
    // outright, and a run terminal enough to delete has no controllers left to
    // abort (the `status !== 'running'` gate is what makes that true).
    if (getState().run.state?.runId === a.runId) dispatch(runClosed())
    dispatch(workflowApi.util.invalidateTags(['Runs']))
  }
}
