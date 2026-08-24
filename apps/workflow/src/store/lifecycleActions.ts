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
import { replayRun } from '../lib/runner/replay'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, StepStatus } from '../lib/runner/types'
import { createRunStore } from '../lib/runStore'
import type { RunStore } from '../lib/runStore'
import type { AppThunk, RootState } from './index'
import { runnerControllers } from './runnerMiddleware'
import { getOwnerId } from './runnerActions'
import { runEvent, runOpened, runReplaced } from './runSlice'
import type { RunMeta } from './runSlice'

/** The app's real `RunStore` — fresh per module, matching `defaultRunnerDeps()` (store/index.ts). */
const runStore: RunStore = createRunStore(httpJsonWithReauth)

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
    const l = await runStore.lease(a.runId, owner, takeover)

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
