/**
 * Launching a `script` step (Task 11, Decision 13) — the half of the work the
 * runner middleware cannot do itself.
 *
 * The mirror of `islandLaunch.ts`, with the one difference that decides the
 * whole shape of this file: a script has no pane. Nobody hands the middleware
 * an element, nobody clicks submit — so where an island's launch ends by
 * parking a handle and letting the pane finish the story, a script's launch
 * *is* the story: `step.started` with the evaluated `with`, the module's own
 * `ctx.log`/`ctx.annotate` while it runs, and exactly one terminal event.
 * That's also why there is no handle registry here: the only thing the UI
 * needs is the live log, and that lives in `scripts/logStore` keyed by run and
 * step, reachable without a launch at all.
 *
 * The split with `lib/runner/adapters/script.ts` is the same one-way fence
 * every adapter keeps: what is decidable from plain data (the evaluated
 * inputs, what a module's return value must look like) is pure and lives
 * there; the Worker, the upload, the clock and the dispatches live here.
 */
import { fetchText } from '../islands/hostDeps'
import { annotateEvent } from '../lib/runner/adapters/island'
import type { Clock } from '../lib/runner/adapters/pipeline'
import { succeededEvent } from '../lib/runner/adapters/declared'
import {
  coerceScriptOutputs,
  scriptInputs,
  type ScriptStepArgs,
} from '../lib/runner/adapters/script'
import { OutputTypeError } from '../lib/runner/outputs'
import type { Definition, FileRef, RunState, Step, StepKey } from '../lib/runner/types'
import { uploadBlob } from '../lib/upload'
import { createScriptHost, fetchBytes } from '../scripts/ScriptHost'
import type { ScriptHost, ScriptHostDeps, ScriptRun } from '../scripts/ScriptHost'
import { appendScriptLog } from '../scripts/logStore'
import { runEvent } from './runSlice'

/**
 * The middleware's `RunnerDeps`, narrowed to what a script needs — passed
 * rather than imported so this module and `runnerMiddleware` don't reference
 * each other's types in a circle.
 */
export interface ScriptLaunchDeps {
  clock: Clock
  /** Test seam; the app's real store passes `createScriptHost`. */
  scriptHost?: (deps: ScriptHostDeps) => ScriptHost
}

export interface LaunchScriptArgs {
  step: Step
  key: StepKey
  job: string
  index: number
  def: Definition
  state: RunState
  /** The step's controller signal — `cancelRun`'s `abortAll` reaches the module through it. */
  signal: AbortSignal
  deps: ScriptLaunchDeps
  /**
   * The runner's own `registerFile`, already bound to this step (and to the
   * "outside the run prefix" warning, 06) — a module may return a bare
   * storage path instead of bytes.
   */
  registerFile: (path: string) => Promise<FileRef>
  /** Run-scoped (`scopedDispatch`): everything that folds into the record goes through here. */
  scoped: (action: unknown) => unknown
  getRunState: () => RunState | undefined
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The rejection's own `err.code` (`ScriptError` carries one), else the generic `SCRIPT`. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'SCRIPT'
}

/** Cancellation is not a `ScriptError` — the host rejects with a plain `AbortError`. */
function isAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError'
}

/** The step's `timeout-minutes` budget in ms, if it declared one (03). */
function budgetMs(step: Step): number | undefined {
  const minutes = ((step.raw ?? {}) as Record<string, unknown>)['timeout-minutes']
  return typeof minutes === 'number' ? minutes * 60_000 : undefined
}

/** Word-for-word the pipeline adapter's `timeoutError()` — one budget, one sentence. */
const TIMEOUT_MESSAGE = 'the step exceeded its `timeout-minutes` budget'

/**
 * Evaluate the step's `with`, run the module, and fold whatever comes back
 * into the run. Returns immediately: everything after `step.started` happens
 * on the returned promise of `ScriptHost.run`, and reaches the record through
 * `a.scoped` so a stale finish from an abandoned run can't land.
 *
 * Never throws — a definition bug (`scriptInputs` on a missing `src`, a `src`
 * the host refuses) is recorded as the step's own `SCRIPT_LOAD` failure, which
 * is a truer place for it than a rejected promise nobody is holding.
 */
export function launchScriptStep(a: LaunchScriptArgs): void {
  const now = () => a.deps.clock.now()
  const scope: ScriptStepArgs = {
    step: a.step,
    key: a.key,
    job: a.job,
    index: a.index,
    def: a.def,
    state: a.state,
  }

  const fail = (code: string, message: string) => {
    a.scoped(runEvent({ type: 'step.failed', key: a.key, error: { code, message }, at: now() }))
  }

  let evaluated: { src: string; inputs: Record<string, unknown> }
  try {
    evaluated = scriptInputs(scope)
  } catch (err) {
    // `queued -> failed` is not a legal transition (transitions.ts): every
    // kind's failure passes through `running` first. There are no inputs to
    // show, because computing them is exactly what failed.
    a.scoped(runEvent({ type: 'step.started', key: a.key, inputs: {}, at: now() }))
    fail('SCRIPT_LOAD', messageOf(err))
    return
  }

  // `src` configures the host; it is not module input, and it is not recorded.
  const { src, inputs } = evaluated
  a.scoped(runEvent({ type: 'step.started', key: a.key, inputs, at: now() }))

  /**
   * This step, but only while the run it belongs to is still the one the slice
   * holds — a step key repeats identically across runs of the same workflow,
   * so without the `runId` check a superseded script could annotate a
   * *different* run's identically-keyed step. `step.annotated` is legal only
   * on a non-terminal step (reducer.ts), and a script's own live window is
   * exactly `running`.
   */
  const isRunning = (): boolean => {
    const state = a.getRunState()
    if (!state || state.runId !== a.state.runId) return false
    return state.steps[a.key]?.status === 'running'
  }

  const hostDeps: ScriptHostDeps = {
    fetchText,
    fetchBytes,
    onLog: (line) => appendScriptLog(a.state.runId, a.key, line),
    onAnnotate: (args) => {
      if (!isRunning()) return
      // The budget is per step, so the call is judged against what the row
      // already holds (apps#370).
      const existing = a.getRunState()?.steps[a.key]?.annotations ?? []
      const event = annotateEvent(a.key, args, now(), existing)
      if ('error' in event) {
        // A refused annotate is the module's mistake, not the step's failure:
        // it is reported where the module's own output goes, and the script
        // runs on. (`ctx.annotate` is fire-and-forget over `postMessage` —
        // there is no reply channel to throw back down.)
        appendScriptLog(a.state.runId, a.key, `annotate rejected: ${event.error}`)
        return
      }
      a.scoped(runEvent(event))
    },
  }

  let run: ScriptRun
  try {
    run = (a.deps.scriptHost ?? createScriptHost)(hostDeps).run({
      impl: a.state.impl,
      src,
      inputs,
      signal: a.signal,
    })
  } catch (err) {
    // `ScriptHost.run` throws synchronously only on a `src` that escapes the
    // implementation's own bundle — a definition bug (09), same class as a
    // missing `src` above.
    fail('SCRIPT_LOAD', messageOf(err))
    return
  }

  /**
   * `timeout-minutes` (03). The pipeline adapter measures its budget inside
   * its own poll loop; a script has no loop to check, so the budget is a timer
   * the launcher holds — through `deps.clock`, not `setTimeout`, so a test's
   * virtual clock drives it like every other wait in the runner.
   *
   * Which of the two aborts fired is not something the host can tell us — it
   * rejects with the same `AbortError` either way — so `timedOut` is what
   * separates a spent budget from the user pressing cancel.
   */
  const budget = budgetMs(a.step)
  const timer = new AbortController()
  let timedOut = false
  if (budget !== undefined) {
    void a.deps.clock.sleep(budget, timer.signal).then(
      () => {
        if (timer.signal.aborted) return
        timedOut = true
        run.abort()
      },
      () => {
        // The step settled first and cancelled the timer; nothing to do.
      },
    )
  }

  void (async () => {
    let returned: unknown
    try {
      returned = await run.outputs
      // The budget bounds the *module*: it is the only part an abort can
      // actually stop (the host hard-terminates the Worker), so the timer is
      // released the moment the module is done, either way.
      timer.abort()
    } catch (err) {
      timer.abort()
      if (timedOut) {
        fail('TIMEOUT', TIMEOUT_MESSAGE)
        return
      }
      if (isAbort(err)) {
        // Deliberately silent, exactly like an abandoned island mount. An
        // abort is never *this* module's news to report: `cancelRun` has
        // already dispatched `step.cancelled` for every non-terminal step
        // before it aborted anything, and the other two abort paths — a lost
        // lease (`loseLease`) and a superseded adoption (`resetRunnerState`)
        // — must leave the record untouched. Readonly means "not ours to
        // drive", not "cancelled", and `scopedDispatch` would not catch a
        // lease loss (the run's own status is still `running`), so a
        // `step.cancelled` from here would write a terminal row for a run
        // another tab now owns.
        return
      }
      fail(codeOf(err), messageOf(err))
      return
    }

    let outputs: Record<string, unknown>
    try {
      outputs = await coerceScriptOutputs(scope, returned, {
        uploadBlob: (blob, name) =>
          uploadBlob({
            impl: a.state.impl,
            workflow: a.state.workflow,
            scope: `runs/${a.state.runId}/${a.key}`,
            blob,
            name,
          }),
        registerFile: a.registerFile,
      })
    } catch (err) {
      fail(err instanceof OutputTypeError ? 'OUTPUT_TYPE' : codeOf(err), messageOf(err))
      return
    }

    // `succeededEvent` — the same builder a form/island submit uses — so the
    // step's own `summary:`/`annotations:` templates are evaluated against the
    // outputs it just produced, and join whatever `ctx.annotate` already
    // appended (Decision 12; the reducer does the joining).
    a.scoped(runEvent(succeededEvent(scope, outputs, now())))
  })()
}
