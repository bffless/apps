/**
 * The wait clock (Task 9, Decision 10): `timeout-minutes` for the two step
 * kinds that wait on somebody — `form` and `island`.
 *
 * Every other kind measures its own budget from inside its own work: a
 * pipeline checks the deadline in its poll loop, a script holds a timer around
 * its Worker (`scriptLaunch.ts`, the pattern this file mirrors). A waiting step
 * has no work to hang a timer off — the middleware dispatches `step.waiting`
 * and then *nothing happens at all* until a person, an island or the clock
 * speaks. So the timer belongs to whoever owns the step's lifecycle, which is
 * the middleware.
 *
 * Two things follow from that, and shape this module:
 *
 * - The budget is measured from the step's `startedAt` (the reducer stamps one
 *   at `step.waiting`), never from the moment the timer was armed. A resumed
 *   step gets what is *left* of its minute, not a fresh one — the record is the
 *   truth about when the wait began, and a run that is passed between tabs must
 *   not be able to wait forever by being adopted repeatedly.
 * - The timer runs on the injected `Clock`, not `setTimeout`, so a test's
 *   virtual clock drives it exactly like every other wait in the runner.
 *
 * Module-level registry, like `islandLaunch`'s handles and the middleware's
 * controllers, and for the same reason: only one run is ever driven per tab,
 * and the arming point (a `runEvent` effect) is not where the disarming points
 * are (a terminal event, a finished run, a lease loss, an adoption).
 */
import { waitBudgetMs } from '../lib/runner/headless'
import type { Clock } from '../lib/runner/adapters/pipeline'
import type { RunState, Step, StepKey } from '../lib/runner/types'
import { runEvent } from './runSlice'

/** Keyed `<runId>:<StepKey>` — a step key repeats identically across runs of the same workflow. */
const clocks = new Map<string, () => void>()

function clockKey(runId: string, key: StepKey): string {
  return `${runId}:${key}`
}

export interface ArmWaitClockArgs {
  /** The step's *declaration* — where `timeout-minutes` lives. */
  step: Step
  key: StepKey
  /** The post-event run state: `state.steps[key].startedAt` is what the budget is measured from. */
  state: RunState
  clock: Clock
  /** `run.headless` — it decides both the default budget and the error code. */
  headless: boolean
  /** Run-scoped (`scopedDispatch`): a timeout is a run event like any other. */
  scoped: (action: unknown) => unknown
  /** The clock reading the caller stamped its own event with — the instant the wait clock is armed. */
  now: number
  getRunState: () => RunState | undefined
}

/**
 * Arm the step's `timeout-minutes` (or, headless, the 5-minute default) and
 * return the disarm. A step with no budget arms nothing — the returned disarm
 * is then a no-op, and an interactive run waits for its person indefinitely.
 *
 * The failure lands as the step's own `step.failed`, still guarded on the step
 * being `waiting` when the clock actually fires: a submit that raced the timer
 * wins (the step is terminal by then), and a run this tab no longer drives is
 * unreachable through `scoped` anyway.
 */
export function armWaitClock(a: ArmWaitClockArgs): () => void {
  const id = clockKey(a.state.runId, a.key)
  // Re-arming supersedes: a second `step.waiting` for the same step (Resume
  // re-affirming the status) must leave one timer behind, not two.
  clocks.get(id)?.()

  const budget = waitBudgetMs(a.step, a.headless)
  if (budget === undefined) return () => {}

  const error = {
    code: a.headless ? 'HEADLESS_TIMEOUT' : 'TIMEOUT',
    message: 'the step exceeded its `timeout-minutes` budget',
  }

  /** Only while the step is still the waiting step of the run this clock was armed for. */
  const stillWaiting = (): boolean => {
    const state = a.getRunState()
    if (!state || state.runId !== a.state.runId) return false
    return state.steps[a.key]?.status === 'waiting'
  }

  const fail = () => {
    if (!stillWaiting()) return
    a.scoped(runEvent({ type: 'step.failed', key: a.key, error, at: a.clock.now() }))
  }

  // The record is what says when the wait began; `a.now` is only the fallback
  // for a row so old it has no `startedAt` at all (M2 wrote none for forms).
  const startedAt = a.state.steps[a.key]?.startedAt ?? a.now
  const remaining = budget - (a.now - startedAt)

  // Spent while the tab was away: there is nothing left to wait for, and
  // sleeping zero would only defer the same verdict by a tick.
  if (remaining <= 0) {
    fail()
    return () => {}
  }

  const timer = new AbortController()
  const disarm = () => {
    clocks.delete(id)
    timer.abort()
  }
  clocks.set(id, disarm)

  void a.clock.sleep(remaining, timer.signal).then(
    () => {
      clocks.delete(id)
      fail()
    },
    () => {
      // Disarmed — the step settled, the run went away, or this tab stopped
      // driving it. None of those are this timer's news to report.
    },
  )

  // The brief's interface. The middleware disarms through the registry
  // (`disarmWaitClock` / `disarmAllWaitClocks`) instead — the clock outlives
  // the effect that armed it, and every disarming point is somewhere else.
  return disarm
}

/** The step reached a terminal state (or is about to be abandoned): forget its clock. */
export function disarmWaitClock(runId: string, key: StepKey): void {
  clocks.get(clockKey(runId, key))?.()
}

/**
 * Every armed clock, gone. Called wherever this tab stops being the one that
 * may write the run's events — a finished run, a superseded adoption, a lost
 * lease — mirroring `disposeAllIslandHandles`. A lease loss is the case that
 * makes this necessary rather than tidy: the run's own status is still
 * `running` and the runId/generation are unchanged, so `scopedDispatch` would
 * not stop a fired clock from writing a terminal row for a run another tab now
 * owns.
 */
export function disarmAllWaitClocks(): void {
  for (const disarm of [...clocks.values()]) disarm()
  clocks.clear()
}
