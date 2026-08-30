/**
 * The runner middleware (09: "side effects live in one RTK listener
 * middleware"): the write-ahead persistence, the scheduler loop and the
 * lease heartbeat, all driven off `runSlice.actions.runEvent`.
 *
 * On every dispatched event:
 *  1. PERSIST — `eventToWrites` (rows.ts) says what to write; each write goes
 *     through `RunStore`, retried once, and a run whose write still fails is
 *     parked (`runPaused`) rather than continuing unrecorded (05).
 *  2. SCHEDULE — if the run is `live` and `running`, `nextActions` (next.ts)
 *     says what happens next; each action is turned into further `runEvent`
 *     dispatches, which re-enter this same listener recursively.
 *  3. HEARTBEAT — started on `run.started`, ticks every 15 s, stopped on
 *     `run.finished` / `runClosed` / a persistence pause.
 *
 * Not under the `lib/runner` purity fence: this is the app's IO/Redux glue.
 */
import { createListenerMiddleware } from '@reduxjs/toolkit'
import type { ListenerMiddleware } from '@reduxjs/toolkit'
import type { IslandHost, IslandHostDeps } from '../islands/IslandHost'
import { toFileRef } from '../lib/coerce'
import type { RunStore } from '../lib/runStore'
import { buildRunContexts, evalOutputDecl } from '../lib/runner/contexts'
import { completeFormStep, formInitialValues, formInputs } from '../lib/runner/adapters/form'
import { runPipelineStep } from '../lib/runner/adapters/pipeline'
import { RegisterFileError, withRegisterRetry } from '../lib/runner/registerRetry'
import type { Clock, HttpJson, StepRuntime } from '../lib/runner/adapters/pipeline'
import type { StepScope } from '../lib/runner/adapters/declared'
import { evaluateSkipOutputs, headlessMode, unattendedStep } from '../lib/runner/headless'
import { nextActions } from '../lib/runner/next'
import type { NextAction } from '../lib/runner/next'
import { isUnavailablePayload, offloadOutputs } from '../lib/runner/payload'
import { isTruncatedStub } from '../lib/runner/results'
import { eventToWrites } from '../lib/runner/rows'
import type { PersistWrite, RunRow } from '../lib/runner/rows'
import type { Definition, FileRef, RunEvent, RunState, Step, StepError, StepKey, StepState } from '../lib/runner/types'
import { uploadBlob } from '../lib/upload'
import type { ScriptHost, ScriptHostDeps } from '../scripts/ScriptHost'
import { clearAllScriptLogs } from '../scripts/logStore'
import { disposeAllIslandHandles, disposeIslandHandle, launchIslandStep } from './islandLaunch'
import type { IslandLaunchDeps } from './islandLaunch'
import { launchScriptStep } from './scriptLaunch'
import type { ScriptLaunchDeps } from './scriptLaunch'
import { armWaitClock, disarmAllWaitClocks, disarmWaitClock } from './waitClock'
import { getOwnerId } from './runnerActions'
import { runClosed, runEvent, runModeChanged, runOpened, runPaused, runReplaced } from './runSlice'
import type { RunSliceState } from './runSlice'
import { workflowApi } from './workflowApi'

/**
 * The one slice this middleware reads. Deliberately *not* the app's `RootState`
 * (from `store/index.ts`) — that type is `ReturnType<typeof makeStore>`, and
 * `makeStore` itself wires this middleware in, so typing against the full
 * `RootState` here would make the two modules' types circularly reference each
 * other (a real `tsc` error, not just a lint nicety). Every store this
 * middleware plugs into has at least a `run` slice; that is all it needs.
 */
export interface HasRunSlice {
  run: RunSliceState
}

export interface RunnerDeps {
  http: HttpJson
  clock: Clock
  runStore: RunStore
  /** Register a bare pipeline path (02) under the run scope. */
  registerFile: (state: RunState, key: StepKey, path: string) => Promise<FileRef>
  /**
   * How an `island` step's host is built (Task 5). Optional so the test
   * fixtures that predate islands keep compiling; `defaultRunnerDeps()` passes
   * the real `createIslandHost`, which `islandLaunch` also falls back to.
   */
  islandHost?: (deps: IslandHostDeps) => IslandHost
  /**
   * How a `script` step's Worker host is built (Task 11). Optional for the
   * same reason `islandHost` is: `defaultRunnerDeps()` passes the real
   * `createScriptHost`, which `scriptLaunch` also falls back to, and the test
   * fixtures that drive no script keep compiling.
   */
  scriptHost?: (deps: ScriptHostDeps) => ScriptHost
}

/** `RunnerDeps`, narrowed to what launching an island actually needs. */
function islandDeps(deps: RunnerDeps): IslandLaunchDeps {
  return {
    http: deps.http,
    now: () => deps.clock.now(),
    ...(deps.islandHost ? { islandHost: deps.islandHost } : {}),
  }
}

/** The same, for a script: a clock (the `timeout-minutes` timer) and the host factory. */
function scriptDeps(deps: RunnerDeps): ScriptLaunchDeps {
  return {
    clock: deps.clock,
    ...(deps.scriptHost ? { scriptHost: deps.scriptHost } : {}),
  }
}

const HEARTBEAT_MS = 15_000
const LEASE_MS = 60_000

const TERMINAL_STEP_EVENTS = new Set([
  'step.succeeded', 'step.failed', 'step.skipped', 'step.cancelled',
])

function isTerminalStepEvent(event: RunEvent): event is Extract<RunEvent, { key: StepKey }> {
  return TERMINAL_STEP_EVENTS.has(event.type)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Controllers — one AbortController per in-flight step, exposed for
// Task 18/19 (cancel, resume). A module-level singleton (only one live run is
// ever driven per tab), but keyed by `<runId>:<StepKey>` — a step key
// (`<job>/<index>/<step>`) repeats identically across every run of the same
// workflow, so a bare `StepKey` map would let a stale entry from a previous
// run of the same workflow shadow the identical key in a brand-new run (a
// re-run would see `runnerControllers.has(a.key)` true for a step it never
// started, and the scheduler would silently never start it). The public
// surface stays exactly `abort(key)`/`abortAll()`/`has(key)` — Task 18/19's
// contract — scoped internally to whichever run is currently driving
// (`currentRunId`, set on `run.started` and on `runReplaced` mode `live`).
// ---------------------------------------------------------------------------

const controllers = new Map<string, AbortController>()
let currentRunId: string | null = null

/**
 * Bumped every `resetRunnerState()` (fix round 1, finding 1): the same
 * `runId` can become current twice in a row — the same run adopted (`openRun`
 * / `takeOver`) a second time in this tab before its first adoption's
 * relaunched steps have all reached a terminal state. `scopedDispatch`'s
 * `runId === currentRunId` check alone can't tell those two adoptions apart
 * (it's the *same* run both times), so a stale emit from the first
 * adoption's now-abandoned adapter — its own `cancel()` on the abort
 * `resetRunnerState` just fired — would otherwise still pass the runId check
 * and land on the identical step key the second adoption owns (already
 * terminal by then in the common case, which `assertTransition`'s
 * `cancelled`/self-transition path only papers over for *that* particular
 * pair of statuses — a stale `step.succeeded` racing a fresh `step.
 * cancelled` the other way round still throws `IllegalTransition`). Each
 * `scopedDispatch` closure captures the generation live at its own creation;
 * a reset — same run or not — invalidates every closure made before it.
 */
let currentGeneration = 0

function controllerKey(runId: string, key: StepKey): string {
  return `${runId}:${key}`
}

/**
 * Guards `finish` against a narrow race: two independent terminal-producing
 * events (e.g. the last steps of two parallel jobs) can each independently
 * compute `nextActions` and see the whole run terminal before either has
 * dispatched `run.finished` — reducer state updates synchronously at dispatch
 * time, ahead of either event's own listener effect reaching its own
 * schedule check. A duplicate `run.finished` would be harmless (the reducer
 * has no invariant against re-applying it) but wasteful; this makes it not
 * happen at all.
 */
const finishing = new Set<string>()

export const runnerControllers = {
  abort(key: StepKey): void {
    if (!currentRunId) return
    const k = controllerKey(currentRunId, key)
    controllers.get(k)?.abort()
    controllers.delete(k)
  },
  abortAll(): void {
    for (const c of controllers.values()) c.abort()
    controllers.clear()
  },
  has(key: StepKey): boolean {
    return currentRunId !== null && controllers.has(controllerKey(currentRunId, key))
  },
}

// ---------------------------------------------------------------------------
// Real `Clock` — the app's implementation; tests inject a fake.
// ---------------------------------------------------------------------------

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      const id = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(id)
          reject(new DOMException('aborted', 'AbortError'))
        },
        { once: true },
      )
    }),
}

/** `POST /api/workflow/files/register` (06): the app's real `registerFile`. */
export function createRegisterFile(http: HttpJson): RunnerDeps['registerFile'] {
  return async (state, key, path) => {
    const res = await http('/api/workflow/files/register', {
      method: 'POST',
      body: { impl: state.impl, workflow: state.workflow, scope: `runs/${state.runId}/${key}`, storageKey: path },
    })
    if (!res.ok) throw new RegisterFileError(path, res.status)
    return toFileRef(res.body)
  }
}

// ---------------------------------------------------------------------------
// The write-ahead persist queue — one promise chain per run (05).
// ---------------------------------------------------------------------------

const writeQueues = new Map<string, Promise<unknown>>()

function enqueue<T>(runId: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(runId) ?? Promise.resolve()
  const next = prev.then(task, task)
  writeQueues.set(runId, next)
  return next
}

async function executeWrite(store: RunStore, write: PersistWrite): Promise<void> {
  if (write.op === 'create') return store.createRun(write.row)
  if (write.op === 'patch') return store.patchRun(write.id, write.patch)
  return store.upsertStep(write.runId, write.key, write.patch)
}

/** Retry once; never rejects — the caller reads `.ok`. */
async function persistWrite(store: RunStore, write: PersistWrite): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await executeWrite(store, write)
    return { ok: true }
  } catch {
    try {
      await executeWrite(store, write)
      return { ok: true }
    } catch (error) {
      return { ok: false, error }
    }
  }
}

function pauseMessage(event: RunEvent, error: unknown): string {
  const key = 'key' in event ? event.key : undefined
  const detail = messageOf(error)
  return key ? `Could not save step ${key}: ${detail}` : `Could not save the run: ${detail}`
}

// ---------------------------------------------------------------------------
// `{"$file"}` payload offload (Task 12) — the `offloadOutputs` `store`
// function for a `step.succeeded`/`run.finished` write, scoped under the run
// (`runs/<runId>/<key>` for a step, `runs/<runId>/outputs` for the run
// itself; `uploadBlob`'s prepare rule takes any scope string).
//
// The upload is threaded a real `AbortSignal` so a cancel / lease loss
// (`runnerControllers.abortAll()`, fired by `resetRunnerState`/`loseLease`/
// the effect's own pause path) interrupts the round trip rather than leaving
// it to run to completion on behalf of a run this tab may no longer drive.
// ---------------------------------------------------------------------------

function offloadStore(
  runState: RunState,
  key: StepKey | undefined,
  signal: AbortSignal,
): (name: string, json: string) => Promise<FileRef> {
  const scope = key ? `runs/${runState.runId}/${key}` : `runs/${runState.runId}/outputs`
  return (name, json) =>
    uploadBlob({
      impl: runState.impl,
      workflow: runState.workflow,
      scope,
      blob: new Blob([json], { type: 'application/json' }),
      name: `${name}.json`,
      signal,
    })
}

/** The synthetic `controllers` map key for a run-level (`run.finished`) offload — no step to hang it off, so a fresh controller is registered under this key instead. Never collides with a real `StepKey` (`<job>/<index>/<step>` always contains `/`). */
function runOutputsControllerKey(runId: string): string {
  return `${runId}:__outputs__`
}

/**
 * The controller an offload's upload should watch. For a step, this reuses
 * the step's own controller — already registered by `handleNextAction`'s
 * `start` case and not yet removed (that happens later in this same effect,
 * in the terminal-cleanup block below) — so `runnerControllers.abort(key)`/
 * `abortAll()` cancel the offload exactly like any other in-flight step
 * work, with no separate bookkeeping. A run-level offload has no step to
 * reuse, so a fresh controller is registered into the same shared map under
 * `runOutputsControllerKey` — `abortAll()` (cancel, lease loss, a fresh
 * `resetRunnerState()`) still reaches it that way.
 */
function offloadController(runId: string, key: StepKey | undefined): AbortController {
  if (!key) {
    const k = runOutputsControllerKey(runId)
    const existing = controllers.get(k)
    if (existing) return existing
    const fresh = new AbortController()
    controllers.set(k, fresh)
    return fresh
  }
  const existing = controllers.get(controllerKey(runId, key))
  if (existing) return existing
  // A step's controller is normally already registered by the time its own
  // `step.succeeded` reaches here (`handleNextAction`'s `start` case); a
  // missing one means something already aborted/cleared it (e.g. a lease
  // loss's `abortAll()` beat this task to the front of the run's write
  // queue). Hand back an already-aborted stand-in rather than a fresh,
  // unsupervised one, so the offload below gives up immediately instead of
  // running to completion on behalf of a run this tab no longer drives.
  const stale = new AbortController()
  stale.abort()
  return stale
}

/** Forgets a run-level offload's synthetic controller once its own call settles. A step's controller is left alone — it is owned by the normal step lifecycle (the terminal-cleanup block's `runnerControllers.abort`), not by this call. */
function releaseOffloadController(runId: string, key: StepKey | undefined): void {
  if (key) return
  controllers.delete(runOutputsControllerKey(runId))
}

type WriteOutcome = { ok: true } | { ok: false; error: unknown } | { ok: 'stale' }

/**
 * The full write for one event — offload (if any) *then* `eventToWrites`
 * *then* every `persistWrite` — run as a single task inside the run's own
 * write-ahead queue (`enqueue`, called synchronously by the caller before
 * this ever starts). Folding the offload in here, rather than awaiting it
 * ahead of `enqueue()`, is what keeps write order equal to event order even
 * when one event's offload is slow and a later, offload-free event's write
 * would otherwise be free to race ahead of it (Task 12 fix round 1 —
 * `enqueue`'s promise chain only orders calls made *before* any await, and
 * parallel/matrix steps dispatch their `runEvent`s through concurrently
 * running listener effects).
 *
 * `{ ok: 'stale' }` means the offload's own upload was aborted (a cancel,
 * or a lease loss aborting the step's/run's controller — see
 * `offloadController`) or the run stopped being the one this tab drives
 * partway through the round trip (`runId`/`generation`, the same pair
 * `scopedDispatch` checks) — the write is dropped silently: not persisted,
 * and not a `runPaused` failure either, since nothing about the offload
 * genuinely failed on its own terms.
 */
async function writeEvent(
  event: RunEvent,
  runState: RunState,
  slice: RunSliceState,
  runStore: RunStore,
  generation: number,
): Promise<WriteOutcome> {
  const runId = runState.runId
  let outputsOverride: Record<string, unknown> | undefined

  // `step.skipped` is here alongside `step.succeeded` because a `headless: skip`
  // is the run's *other* output carrier (M3 Task 12): its declared value can be
  // an expression over an upstream output — `${{ needs.card.outputs.big }}` —
  // and an oversized one must become a `{"$file"}` stub for exactly the same
  // reason a succeeded step's does, or the row write exceeds the record budget
  // and parks the run. A scheduler skip carries no outputs and falls straight
  // through the `if (outputs)` guard below.
  if (
    event.type === 'step.succeeded' ||
    event.type === 'step.skipped' ||
    event.type === 'run.finished'
  ) {
    const outputs =
      event.type === 'run.finished' ? runState.outputs : runState.steps[event.key]?.outputs
    if (outputs) {
      const key = event.type === 'run.finished' ? undefined : event.key
      const controller = offloadController(runId, key)
      try {
        outputsOverride = await offloadOutputs(outputs, offloadStore(runState, key, controller.signal))
      } catch (error) {
        releaseOffloadController(runId, key)
        return controller.signal.aborted ? { ok: 'stale' } : { ok: false, error }
      }
      releaseOffloadController(runId, key)
      if (controller.signal.aborted || runId !== currentRunId || generation !== currentGeneration) {
        return { ok: 'stale' }
      }
    }
  }

  const writes = eventToWrites(event, { state: runState, runRow: () => rowFromSlice(slice), outputsOverride })
  for (const write of writes) {
    const result = await persistWrite(runStore, write)
    if (!result.ok) return { ok: false, error: result.error }
  }
  return { ok: true }
}

/** The `run.started` insert row (05); the lease is set at creation — this tab drives it. */
function rowFromSlice(slice: RunSliceState): RunRow {
  const { meta, state } = slice
  if (!meta || !state) throw new Error('runnerMiddleware: run.started fired with no meta/state to build a row from')
  return {
    runId: state.runId,
    impl: state.impl,
    workflow: state.workflow,
    workflowName: meta.workflowName,
    ...(meta.workflowVersion === undefined ? {} : { workflowVersion: meta.workflowVersion }),
    definition: meta.def.raw,
    yaml: meta.yaml,
    inputs: state.inputs,
    status: state.status,
    headless: state.headless,
    unattended: state.unattended,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? null,
    leaseOwner: getOwnerId(),
    leaseUntil: Date.now() + LEASE_MS,
    outputs: state.outputs ?? null,
    annotations: state.annotations,
  }
}

// ---------------------------------------------------------------------------
// Heartbeat (05 Resume): lease refresh + step heartbeatAt, every 15 s.
// ---------------------------------------------------------------------------

const heartbeats = new Map<string, AbortController>()

function stopHeartbeat(runId: string): void {
  heartbeats.get(runId)?.abort()
  heartbeats.delete(runId)
}

/**
 * Every module-level structure this middleware keeps outside the Redux
 * store, wiped clean. Called whenever a *new* run is about to become the one
 * this tab drives (`runOpened` — fresh kickoff — and `runReplaced` — resume
 * adoption), so a previous run's abandoned heartbeat/controllers/write-queue
 * can never bleed into the new one. `runClosed` alone is not a reliable
 * enough hook for this: nothing in the app dispatches it today, and even if
 * it did, `runOpened` fires *before* the old run's state is torn down.
 */
function resetRunnerState(): void {
  for (const runId of [...heartbeats.keys()]) stopHeartbeat(runId)
  // Abort, don't just drop: a genuinely in-flight step (an HTTP call, a
  // retry/poll parked in `clock.sleep`) is not stopped by clearing the map
  // out from under it — nothing observes `controllers` again once it's
  // gone. `runnerControllers.abortAll()` fires every controller's signal
  // *and* clears the map, so the adapter's own `rt.signal.aborted` checks
  // (pipeline.ts) actually see the abort and cancel rather than running on.
  runnerControllers.abortAll()
  // A bridge outlives its controller's abort: `AbortSignal` only reaches a
  // mount that is still in flight, and a *mounted* island keeps answering
  // `tools/call` until its host is closed. Aborting and forgetting would leave
  // an abandoned run's island live in the page.
  void disposeAllIslandHandles('cancelled')
  // A script's live log lines belong to the run that produced them: the
  // moment a different run becomes the one this tab drives, nothing from the
  // old one may stay on the page. Finished steps already persisted their
  // capped tail on the terminal upsert (apps#527); what this drops is only
  // the live copy — and the lines of a step that never reached a terminal
  // event, the accepted trade-off of writing once per step, not per line.
  clearAllScriptLogs()
  // The wait clocks of the run being abandoned (Task 9): a fired timer would
  // otherwise fail a step of a run this tab no longer drives.
  disarmAllWaitClocks()
  writeQueues.clear()
  finishing.clear()
  currentRunId = null
  currentGeneration += 1
}

/**
 * This tab no longer drives the run: the view goes readonly, in-flight steps
 * are aborted, and every island bridge is closed (apps#370) — a mounted island
 * keeps answering `tools/call` until its host is closed, and aborting its
 * controller alone would leave it live, with a `workflow.submit` that lands
 * on a run this tab has no lease over. The record itself is untouched.
 */
function loseLease(dispatch: (action: unknown) => unknown): void {
  dispatch(runModeChanged('readonly'))
  runnerControllers.abortAll()
  void disposeAllIslandHandles('unmounted')
  // Same reason the bridges close: a `timeout-minutes` clock still armed here
  // would write a terminal row for a run another tab now owns — the run's own
  // status is still `running`, so `scopedDispatch` would let it through.
  disarmAllWaitClocks()
}

const NON_TERMINAL_STEP = new Set(['queued', 'running', 'polling', 'waiting'])

function startHeartbeat(
  runId: string,
  deps: RunnerDeps,
  dispatch: (action: unknown) => unknown,
  getState: () => unknown,
): void {
  if (heartbeats.has(runId)) return
  const controller = new AbortController()
  heartbeats.set(runId, controller)
  const owner = getOwnerId()
  // The best-known expiry of the lease this tab currently holds — seeded at
  // the same `LEASE_MS` window `rowFromSlice`/the lease response itself
  // grants, and refreshed from every successful renewal below. This is the
  // yardstick a *transport* failure (finding 1, fix round 3) is measured
  // against: `deps.runStore.lease` throwing (a 502, a network blip) answers
  // nothing about who holds the lease — it is not the same fact as a
  // genuine `{ ok: false }` denial — so it must not demote this tab on its
  // own. The lease window is 3x the heartbeat period (60s vs 15s), so a
  // single failed request always has at least two more tries left before
  // the lease could plausibly have actually expired server-side.
  let leaseUntil = deps.clock.now() + LEASE_MS

  void (async () => {
    for (;;) {
      try {
        await deps.clock.sleep(HEARTBEAT_MS, controller.signal)
      } catch {
        return
      }
      if (controller.signal.aborted) return

      // `undefined` marks a transport failure (the request itself threw);
      // any resolved value — including `{ ok: false }` — is the server's own
      // answer about the lease, denial included.
      let result: { ok: boolean; leaseUntil?: number } | undefined
      try {
        result = await deps.runStore.lease(runId, owner)
      } catch {
        result = undefined
      }
      if (controller.signal.aborted) return

      // Whether *this* heartbeat's run is still the one actually driving the
      // tab. A heartbeat whose run was superseded (a new run opened, or this
      // one got replaced) without its own controller being aborted first —
      // belt-and-suspenders alongside `resetRunnerState` — must never act on
      // behalf of whatever run *is* current now; both branches below read
      // this the same way (the previous `ok:true` path already did; the
      // `ok:false` path used to skip the check and could flip the *current*
      // run readonly / abort its controllers on an abandoned run's say-so).
      const slice = (getState() as HasRunSlice).run
      const runState = slice.state
      const isCurrent = runState?.runId === runId

      if (!result) {
        // A failed *request*, not a lost lease (finding 1): try again next
        // tick, same as any other missed beat, as long as the lease this tab
        // last knew about hasn't actually run out yet.
        if (deps.clock.now() < leaseUntil) continue
        if (isCurrent) loseLease(dispatch)
        heartbeats.delete(runId)
        return
      }

      if (!result.ok) {
        if (isCurrent) loseLease(dispatch)
        heartbeats.delete(runId)
        return
      }

      leaseUntil = result.leaseUntil ?? deps.clock.now() + LEASE_MS

      if (isCurrent && runState) {
        const now = deps.clock.now()
        for (const step of Object.values(runState.steps)) {
          if (!NON_TERMINAL_STEP.has(step.status)) continue
          try {
            await deps.runStore.upsertStep(runId, step.key, { heartbeatAt: now })
          } catch {
            // A missed heartbeat write is not fatal — the next tick tries again.
          }
        }
      }
    }
  })()
}

// ---------------------------------------------------------------------------
// The scheduler: NextAction → RunEvent
// ---------------------------------------------------------------------------

/** What the slice is parked with when a resume is refused (see the `runReplaced` listener). */
const RESUME_REFUSED =
  'Resume refused: this run has recorded outputs that could not be loaded. Retry re-reads the run.'

/**
 * Every output of a replayed run that came back as the `{ $file, $error }`
 * sentinel — a `{"$file"}` payload the read path could not fetch. Step rows
 * first, then the run's own outputs (which carry no step key).
 */
function unavailableOutputs(
  state: RunState,
): { stepKey?: StepKey; name: string; error: string }[] {
  const found: { stepKey?: StepKey; name: string; error: string }[] = []
  const scan = (outputs: Record<string, unknown> | undefined, key?: StepKey) => {
    for (const [name, value] of Object.entries(outputs ?? {})) {
      if (isUnavailablePayload(value)) {
        found.push({ ...(key ? { stepKey: key } : {}), name, error: value.$error })
      }
    }
  }
  for (const step of Object.values(state.steps)) scan(step.outputs, step.key)
  scan(state.outputs)
  return found
}

function stepOf(def: Definition, job: string, stepId: string): Step | undefined {
  return def.jobs[job]?.steps.find((s) => s.id === stepId)
}

/** One step a resume relaunches, with everything a launch needs already registered (see `resumable`). */
interface Resumable {
  step: StepState
  stepDecl: Step
  controller: AbortController
  scoped: (action: unknown) => unknown
}

/**
 * The steps of one `kind` left in one of `statuses` by the tab that went
 * away — each with its controller registered in the shared `controllers` map
 * (so `cancelRun`'s `abortAll()` reaches the relaunch exactly like a
 * scheduler-started step) and its `scopedDispatch` built the normal way
 * (runId + generation + run-status guarded, so a second adoption supersedes
 * this one cleanly). The three per-kind resume loops in the `runReplaced`
 * listener used to repeat this preamble verbatim (apps#375); a step whose
 * declaration is gone from the definition is skipped, as before.
 */
function resumable(
  state: RunState,
  def: Definition,
  kind: StepState['kind'],
  statuses: readonly StepState['status'][],
  dispatch: (action: unknown) => unknown,
  getRunState: () => RunState | undefined,
): Resumable[] {
  const found: Resumable[] = []
  for (const step of Object.values(state.steps)) {
    if (step.kind !== kind || !statuses.includes(step.status)) continue
    const stepDecl = stepOf(def, step.job, step.stepId)
    if (!stepDecl) continue
    const controller = new AbortController()
    controllers.set(controllerKey(state.runId, step.key), controller)
    found.push({ step, stepDecl, controller, scoped: scopedDispatch(state.runId, dispatch, getRunState) })
  }
  return found
}

/** `workflows/<impl>/<workflow>/runs/<run-id>` (06). */
function runPrefixOf(state: RunState): string {
  return `workflows/${state.impl}/${state.workflow}/runs/${state.runId}`
}

/**
 * Wraps `dispatch` so it only ever forwards an action while `runId` is still
 * `currentRunId`, this closure's own adoption generation is still the live
 * one, and the run hasn't already reached a terminal status. The pipeline
 * adapter's own async chain (`rt.emit`, and any dispatch reachable from it,
 * e.g. `registerFile`'s out-of-prefix warning) is fire-and-forget by design
 * (`StepRuntime.emit` is `void`, not awaited) and keeps running past an
 * abort in at least one path: `runPipelineStep`'s own `cancel()`
 * unconditionally calls `rt.emit({type:'step.cancelled', ...})` even when
 * the abort *is* what triggered it. `resetRunnerState` aborting the
 * controller (so the adapter stops making progress) is necessary but not
 * sufficient on its own — this is the belt that makes a stale event for an
 * abandoned run's step key structurally unable to reach the reducer,
 * whether or not some future code path remembers to abort first:
 *
 * - runId: a step key repeats identically across runs of the same workflow
 *   (`<job>/<index>/<step>`), so without this a stale event doesn't just
 *   risk an IllegalTransition throw — it can silently overwrite a
 *   *different* run's identically-keyed step.
 * - generation (fix round 1, finding 1): the *same* run can become current
 *   twice — a second `openRun`/`takeOver` adoption of a run whose first
 *   adoption's relaunched steps haven't all finished yet — and the runId
 *   check alone can't distinguish "my adoption" from "the one that replaced
 *   me" when both are the same run. `resetRunnerState()` bumps the
 *   generation on every adoption (see its declaration); a closure made
 *   before that bump is permanently stale even though `runId ===
 *   currentRunId` still reads true.
 * - run status (fix round 1, finding 3): a `cancelRun`/finish dispatch can
 *   land — and move the run off `running` — *while* an aborted adapter's own
 *   unwind is still mid-flight (its `cancel()` fires on a later microtask).
 *   That stale event would otherwise still pass both checks above (same
 *   run, same generation — nothing reset in between) and persist as a
 *   spurious extra row write *after* the run's own final patch, breaking
 *   the write-ahead order the record promises. Once the run is no longer
 *   `running`, nothing more from it is legitimate to fold.
 */
function scopedDispatch(
  runId: string,
  dispatch: (action: unknown) => unknown,
  getRunState: () => RunState | undefined,
): (action: unknown) => unknown {
  const generation = currentGeneration
  return (action) => {
    if (runId !== currentRunId || generation !== currentGeneration) return undefined
    const runState = getRunState()
    if (runState?.runId === runId && runState.status !== 'running') return undefined
    return dispatch(action)
  }
}

/**
 * Wraps `deps.registerFile` with the retry policy (`registerRetry.ts`: a 5xx or
 * a dropped connection is asked again, a 4xx is not) and the 06 "outside the
 * run prefix" warning. `signal` is the step's, so a cancelled step does not sit
 * out a backoff.
 */
function registerFileForStep(
  deps: RunnerDeps,
  state: RunState,
  key: StepKey,
  dispatch: (action: unknown) => unknown,
  signal?: AbortSignal,
): (path: string) => Promise<FileRef> {
  const register = withRegisterRetry((path) => deps.registerFile(state, key, path), deps.clock.sleep, signal)
  return async (path) => {
    const file = await register(path)
    if (!path.startsWith(runPrefixOf(state))) {
      dispatch(
        runEvent({
          type: 'run.annotation',
          annotation: {
            level: 'warning',
            message: `Step ${key} registered a file outside the run prefix: ${path}`,
            stepKey: key,
          },
          at: deps.clock.now(),
        }),
      )
    }
    return file
  }
}

/**
 * Per-field messages → one error message, `field: message` joined by `"; "`.
 * The one spelling, shared by `HEADLESS_SKIP` (a declared skip value the step's
 * own map refused) and `HEADLESS_FORM` (an auto-submit its own fields refused):
 * both are "these answers were not acceptable", and a reader should not have to
 * learn two formats for the same news.
 */
function joinFieldErrors(errors: Record<string, string>): string {
  return Object.entries(errors)
    .map(([field, message]) => `${field}: ${message}`)
    .join('; ')
}

type HeadlessDecision =
  | { act: 'run' }
  | { act: 'skip'; outputs: Record<string, unknown> }
  | { act: 'fail'; error: StepError; annotate: boolean }

/**
 * What an unattended run does with a step that would otherwise wait on a person
 * (07, Decision 11).
 *
 * `form` and `island` are the only two kinds with nobody to drive them in CI,
 * so each one has to have said how it runs unattended: `skip` stands its
 * declared outputs in for the work (and never creates the pane at all), `auto`
 * runs the step exactly as an interactive run would — bounded by the wait clock
 * of Task 9 — and a step that declared neither is a definition that simply
 * cannot run headless, which is `HEADLESS_REQUIRED` rather than a run that
 * hangs until its budget runs out.
 *
 * An ordinary interactive run never reaches any of this: `headless:` is not
 * read at all when a person is driving, so a workflow behaves identically with
 * and without the declaration.
 *
 * An **unattended** run (07: "Don't wait for me", the kickoff form's own
 * toggle on an interactive run) reads the declarations exactly as a headless
 * run does — `auto` runs, `skip` stands its outputs in — with one difference:
 * a step that declared neither still *waits for the person*, who is, after
 * all, sitting there. Only the driver's `headless` fails fast on it.
 *
 * A step's own `auto-accept:` (07, apps#435) is the same thing for *one*
 * step: when it evaluates truthy on an interactive run, this step reads its
 * declaration as an unattended run would, and every other step is left to
 * the person. A bad `auto-accept` expression fails the step (`AUTO_ACCEPT`),
 * not the run — it is this step's declaration that is wrong.
 */
function headlessDecision(a: StepScope): HeadlessDecision {
  if (a.step.uses !== 'form' && a.step.uses !== 'island') return { act: 'run' }
  if (!a.state.headless) {
    let unattended: boolean
    try {
      unattended = unattendedStep(a)
    } catch (err) {
      return {
        act: 'fail',
        error: { code: 'AUTO_ACCEPT', message: err instanceof Error ? err.message : String(err) },
        annotate: false,
      }
    }
    if (!unattended) return { act: 'run' }
  }

  const mode = headlessMode(a.step)
  if (mode === undefined) {
    if (!a.state.headless) return { act: 'run' }
    return {
      act: 'fail',
      error: {
        code: 'HEADLESS_REQUIRED',
        message: `step ${a.key} needs a person; declare headless:`,
      },
      // The one failure worth a run-level annotation: it is a fact about the
      // *definition*, not about this run's data, and the run list is where
      // somebody notices that their workflow cannot be automated at all.
      annotate: true,
    }
  }
  if (mode === 'auto') return { act: 'run' }

  const skip = evaluateSkipOutputs(a)
  if (skip.ok) return { act: 'skip', outputs: skip.outputs }
  return {
    act: 'fail',
    error: { code: 'HEADLESS_SKIP', message: joinFieldErrors(skip.errors) },
    annotate: false,
  }
}

/**
 * `headless: auto` on a `form` step: the submit nobody is there to make.
 *
 * The values are the form's *own* initial values — every field's evaluated
 * `default` (03) — and they go through `completeFormStep`, the identical path a
 * person's click takes, so an unattended run and an attended one where nobody
 * changed anything cannot produce different outputs. Defaults that do not
 * satisfy the fields (a `required` field with no default) are the honest
 * failure they would be for a person who submitted an empty form, reported as
 * `HEADLESS_FORM` rather than as a form that sits there.
 *
 * Deferred by one microtask so the step is genuinely `waiting` when it is
 * submitted: that is the status the row records, the wait clock arms off, and
 * the submit's own contexts are built from — and going straight from `queued`
 * to `succeeded` is not a legal transition anyway.
 */
function autoSubmitForm(a: {
  step: Step
  key: StepKey
  job: string
  index: number
  def: Definition
  state: RunState
  deps: RunnerDeps
  dispatch: (action: unknown) => unknown
  getRunState: () => RunState | undefined
}): void {
  const scoped = scopedDispatch(a.state.runId, a.dispatch, a.getRunState)

  void Promise.resolve().then(() => {
    const state = a.getRunState()
    // A run abandoned, adopted elsewhere or already settled in between has no
    // form left to submit. `scoped` would drop the event anyway; this also
    // keeps us from evaluating a submit against somebody else's run state.
    if (!state || state.runId !== a.state.runId) return
    if (state.steps[a.key]?.status !== 'waiting') return

    const values = formInitialValues({
      step: a.step,
      def: a.def,
      state,
      job: a.job,
      index: a.index,
    })
    const at = a.deps.clock.now()
    const result = completeFormStep({
      step: a.step,
      key: a.key,
      job: a.job,
      index: a.index,
      def: a.def,
      state,
      values,
      at,
    })

    scoped(
      runEvent(
        result.ok
          ? result.event
          : {
              type: 'step.failed',
              key: a.key,
              error: { code: 'HEADLESS_FORM', message: joinFieldErrors(result.errors) },
              at,
            },
      ),
    )
  })
}

async function handleNextAction(
  a: NextAction,
  def: Definition,
  runState: RunState,
  deps: RunnerDeps,
  dispatch: (action: unknown) => unknown,
  getRunState: () => RunState | undefined,
): Promise<void> {
  switch (a.kind) {
    case 'expand':
      dispatch(runEvent({ type: 'job.expanded', job: a.job, total: a.total, items: a.items }))
      return

    case 'skip':
      // `a.steps` is a snapshot computed from `runState` at the top of the
      // schedule loop. Dispatching one skip re-enters this same listener
      // (nested, asynchronously) — which can independently compute its own
      // `nextActions` and reach the *same* target before we get to it here
      // (e.g. two matrix items failing close together, each fail-fast-
      // cascading the same still-pending sibling). `step.skipped` is a
      // creation event (`assertNewStep`, reducer.ts): a second one for a key
      // that already has state — from any status, not just `skipped` — is an
      // illegal transition and throws out of `dispatch()`, aborting the rest
      // of this loop and stalling the run. Re-check against the freshest
      // state, not the stale snapshot, immediately before each dispatch.
      for (const s of a.steps) {
        if (getRunState()?.steps[s.key]) continue
        dispatch(
          runEvent({
            type: 'step.skipped',
            key: s.key,
            job: s.job,
            index: s.index,
            stepId: s.stepId,
            kind: s.stepKind,
            at: deps.clock.now(),
          }),
        )
      }
      return

    case 'start': {
      // Guards against a duplicate launch: nested listener re-entrancy could
      // in principle revisit the same proposal before the step's own
      // `step.queued` has settled into state.
      if (runnerControllers.has(a.key)) return
      // The same freshest-state re-check as `case 'skip'`: `a` is a snapshot,
      // and a failure dispatched synchronously from this very case (a
      // `headlessDecision` that fails, a launch that could not start) re-enters
      // the listener, which can reach a *sibling* matrix leg first — queue it,
      // fail it (or fail-fast cancel it) and clear its controller — before this
      // loop gets to it. `step.queued` is a creation event too, so a key that
      // already has state must not be queued again (apps#435).
      if (getRunState()?.steps[a.key]) return
      const step = stepOf(def, a.job, a.stepId)
      if (!step) return

      const scope: StepScope = {
        step,
        key: a.key,
        job: a.job,
        index: a.index,
        def,
        state: runState,
      }
      const headless = headlessDecision(scope)

      // Registered *before* the headless skip below, not just for the kinds
      // that run: a skip carries outputs, and an oversized one is offloaded
      // inside its own write (`writeEvent`), which watches the step's
      // controller exactly as `step.succeeded`'s offload does. Without one
      // registered here `offloadController` would hand that upload an
      // already-aborted stand-in and the row would be dropped silently. The
      // terminal-cleanup block clears it again on `step.skipped` like any
      // other terminal event. (The *scheduler's* skips — `case 'skip'` above —
      // still need none: they carry no outputs, so nothing is ever offloaded
      // for them and `offloadController` is never reached.)
      const controller = new AbortController()
      controllers.set(controllerKey(runState.runId, a.key), controller)

      // A skip replaces `step.queued` rather than following it: `step.skipped`
      // is itself a *creation* event (the reducer's `assertNewStep`), and a
      // step that never runs needs no wait clock.
      if (headless.act === 'skip') {
        dispatch(
          runEvent({
            type: 'step.skipped',
            key: a.key,
            job: a.job,
            index: a.index,
            stepId: a.stepId,
            kind: step.uses,
            outputs: headless.outputs,
            at: deps.clock.now(),
          }),
        )
        return
      }

      dispatch(
        runEvent({
          type: 'step.queued',
          key: a.key,
          job: a.job,
          index: a.index,
          stepId: a.stepId,
          kind: step.uses,
          at: deps.clock.now(),
        }),
      )

      if (headless.act === 'fail') {
        // `queued -> failed` is not a legal transition (transitions.ts), so
        // this passes through `running` first like every other kind's
        // definition-level failure. The annotation goes *before* the failure:
        // `run.finished` is what rolls the annotation counts up (rows.ts), and
        // the terminal step event is what can reach it.
        const at = deps.clock.now()
        dispatch(runEvent({ type: 'step.started', key: a.key, inputs: {}, at }))
        if (headless.annotate) {
          dispatch(
            runEvent({
              type: 'run.annotation',
              annotation: { level: 'error', message: headless.error.message, stepKey: a.key },
              at,
            }),
          )
        }
        dispatch(runEvent({ type: 'step.failed', key: a.key, error: headless.error, at }))
        return
      }

      if (step.uses === 'pipeline') {
        // Scoped, not the raw `dispatch`: this launches a fire-and-forget
        // async chain that can still be mid-flight after the run it belongs
        // to has been abandoned for a new one (see `scopedDispatch`).
        const scoped = scopedDispatch(runState.runId, dispatch, getRunState)
        const rt: StepRuntime = {
          emit: (e) => scoped(runEvent(e)),
          http: deps.http,
          clock: deps.clock,
          signal: controller.signal,
          registerFile: registerFileForStep(deps, runState, a.key, scoped, controller.signal),
        }
        void runPipelineStep({ step, key: a.key, job: a.job, index: a.index, def, state: runState }, rt)
      } else if (step.uses === 'form') {
        // The form's evaluated `with` is what it is shown with; it rides on
        // `step.waiting` since a form never emits `step.started`.
        const inputs = formInputs({ step, job: a.job, index: a.index, def, state: runState })
        dispatch(runEvent({ type: 'step.waiting', key: a.key, inputs, at: deps.clock.now() }))
        // `headless: auto`: nobody is going to click Approve, so the harness
        // submits the form's own defaults once it is `waiting` (see below).
        // Unattended counts too — run-level or this step's own `auto-accept`
        // — and `headlessDecision` has already let this form through only
        // because it declared `auto` (or is being driven), so `unattendedStep`
        // cannot throw here: the same expression was just evaluated.
        if (runState.headless || (unattendedStep(scope) && headlessMode(step) === 'auto')) {
          autoSubmitForm({ ...scope, deps, dispatch, getRunState })
        }
      } else if (step.uses === 'island') {
        // The middleware has no DOM (09): it builds the host and parks a
        // handle, and the *pane* mounts it. `step.waiting` is dispatched from
        // that mount, not from here — an island is `running` while it loads
        // (Decision 11).
        const scoped = scopedDispatch(runState.runId, dispatch, getRunState)
        const launched = launchIslandStep({
          step,
          key: a.key,
          job: a.job,
          index: a.index,
          def,
          state: runState,
          signal: controller.signal,
          deps: islandDeps(deps),
          dispatch,
          scoped,
          getRunState,
        })
        const at = deps.clock.now()
        if (!launched.ok) {
          // A definition bug (`with.src` missing or off-bundle). `queued ->
          // failed` is illegal, so it passes through `running` first, like
          // every other kind's failure.
          dispatch(runEvent({ type: 'step.started', key: a.key, inputs: {}, at }))
          dispatch(
            runEvent({
              type: 'step.failed',
              key: a.key,
              error: { code: 'ISLAND_LOAD', message: launched.error },
              at,
            }),
          )
          return
        }
        // The handle is registered *before* this dispatch, so a pane rendering
        // off `running` always finds one.
        dispatch(
          runEvent({ type: 'step.started', key: a.key, inputs: launched.handle.arguments, at }),
        )
      } else if (step.uses === 'script') {
        // The one kind the middleware drives end to end: no element to hand
        // over, nobody to wait for. The launcher owns every event from
        // `step.started` onwards (Decision 13), including the failure a
        // definition bug in `with.src` becomes.
        const scoped = scopedDispatch(runState.runId, dispatch, getRunState)
        launchScriptStep({
          step,
          key: a.key,
          job: a.job,
          index: a.index,
          def,
          state: runState,
          signal: controller.signal,
          deps: scriptDeps(deps),
          registerFile: registerFileForStep(deps, runState, a.key, scoped, controller.signal),
          scoped,
          getRunState,
        })
      } else {
        // No kind reaches here any more (script was the last one, Task 11) —
        // this is the backstop for a kind added to `StepKind` before the
        // runner learns to run it: the step carries the fault, and the run
        // still reaches a final state.
        //
        // `queued -> failed` is not a legal transition (transitions.ts): every
        // kind's failure passes through `running` first, same as a pipeline
        // step's own terminal-failure path (`step.started` then `step.failed`).
        const at = deps.clock.now()
        dispatch(runEvent({ type: 'step.started', key: a.key, inputs: {}, at }))
        dispatch(
          runEvent({
            type: 'step.failed',
            key: a.key,
            error: {
              code: 'UNSUPPORTED_KIND',
              message: `${step.uses} is not a step kind this harness runs`,
            },
            at,
          }),
        )
      }
      return
    }

    case 'finish': {
      if (finishing.has(runState.runId)) return
      finishing.add(runState.runId)

      const ctx = buildRunContexts(def, runState)
      const outputs: Record<string, unknown> = {}
      const failed: { name: string; err: unknown }[] = []
      for (const [name, decl] of Object.entries(def.outputs)) {
        try {
          outputs[name] = evalOutputDecl(decl, ctx)
        } catch (err) {
          outputs[name] = null
          failed.push({ name, err })
        }
      }
      // `run.finished` first: it is what stops the recursive rescan (`nextActions`
      // returns [] once `state.status` is no longer `running`), so a subsequent
      // `run.annotation` cannot cause a second `finish` to be proposed.
      const at = deps.clock.now()
      dispatch(runEvent({ type: 'run.finished', status: a.status, outputs, at }))
      for (const { name, err } of failed) {
        dispatch(
          runEvent({
            type: 'run.annotation',
            annotation: { level: 'warning', message: `output "${name}" failed to evaluate: ${messageOf(err)}` },
            at,
          }),
        )
      }
      return
    }

    default: {
      const exhaustive: never = a
      throw new Error(`handleNextAction: unknown NextAction: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * Put a `timeout-minutes` clock on a step that has just reached `waiting`
 * (Task 9, Decision 10) — the one arming point for both the kinds that wait.
 *
 * Both paths lead here: the `runEvent` listener on every `step.waiting` (a
 * form's, dispatched inline by `handleNextAction`; an island's, dispatched by
 * its handle's `mount`), and the `runReplaced` listener for a row that replayed
 * straight back to `waiting`. Same call, same budget arithmetic — a resumed
 * step differs only in the `startedAt` the record hands back, which is exactly
 * the difference that should matter.
 *
 * Reads the *freshest* slice rather than a captured state: only a tab that is
 * live, unpaused and still holding this step may arm a timer that will
 * eventually write a terminal row.
 */
function armWaitingStep(
  key: StepKey,
  slice: RunSliceState,
  deps: RunnerDeps,
  dispatch: (action: unknown) => unknown,
  getRunState: () => RunState | undefined,
): void {
  const state = slice.state
  const def = slice.meta?.def
  if (!state || !def || slice.mode !== 'live' || slice.paused !== undefined) return

  const step = state.steps[key]
  if (!step || step.status !== 'waiting') return
  // The only two kinds that wait on somebody; nothing else emits `step.waiting`.
  if (step.kind !== 'form' && step.kind !== 'island') return

  const decl = stepOf(def, step.job, step.stepId)
  if (!decl) return

  armWaitClock({
    step: decl,
    key,
    state,
    clock: deps.clock,
    headless: state.headless,
    scoped: scopedDispatch(state.runId, dispatch, getRunState),
    now: deps.clock.now(),
    getRunState,
  })
}

/**
 * What a `run.finished` leaves behind once it has been written — or dropped
 * as stale (apps#375): the heartbeat, the run's write queue and its
 * `finishing` guard are done with, and the caches that show this run are
 * told. The `Runs` invalidation mirrors `run.started`'s (the runner writes
 * through `RunStore`, never through RTK Query, so the Past-runs list would
 * otherwise not learn the run ended); the specific `Run` is the record a page
 * may already be viewing (`workflowApi.ts`'s `getRun` `providesTags` keys it
 * by run id), which would stay stale otherwise.
 */
function finishRunCleanup(runId: string, dispatch: (action: unknown) => unknown): void {
  stopHeartbeat(runId)
  disarmAllWaitClocks()
  writeQueues.delete(runId)
  finishing.delete(runId)
  dispatch(workflowApi.util.invalidateTags(['Runs', { type: 'Run', id: runId }]))
}

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

export function createRunnerMiddleware(deps: RunnerDeps): ListenerMiddleware<HasRunSlice> {
  const listener = createListenerMiddleware<HasRunSlice>()

  listener.startListening({
    actionCreator: runEvent,
    effect: async (action, listenerApi) => {
      const event = action.payload
      const slice = (listenerApi.getState() as HasRunSlice).run
      const runState = slice.state
      // An event before `run.started` folds to nothing in the slice (runSlice's
      // own rule); nothing to persist or schedule either.
      if (!runState) return

      // `enqueue()` is called synchronously here, before any `await` in this
      // effect — its promise chain only orders calls made in that window
      // (Task 12 fix round 1). The offload (when `step.succeeded`/
      // `run.finished` carries an oversized output) happens *inside*
      // `writeEvent`'s queued task, not ahead of this call, so a slow upload
      // can never let a later event's write land first.
      const generation = currentGeneration
      const outcome = await enqueue(runState.runId, () =>
        writeEvent(event, runState, slice, deps.runStore, generation),
      )

      if (outcome.ok === 'stale') {
        // A `run.finished` whose offload was aborted by a lease loss
        // (`loseLease` → `abortAll`, no `resetRunnerState`) still ends this
        // tab's part in the run: without the cleanup its write queue and
        // `finishing` entry would sit there until the next reset (apps#375).
        // Only for the *current* generation — a `stale` that came from a
        // reset means a new adoption (possibly of this very run) already
        // owns fresh entries under the same id, and they must be left alone.
        if (event.type === 'run.finished' && generation === currentGeneration) {
          finishRunCleanup(runState.runId, listenerApi.dispatch)
        }
        return
      }
      if (!outcome.ok) {
        listenerApi.dispatch(runPaused(pauseMessage(event, outcome.error)))
        runnerControllers.abortAll()
        // Wait clocks too (review round 1): a parked run's writes are failing,
        // and `scopedDispatch` would still let a fired clock through (same
        // run, same generation, status still `running`) — it would land a
        // `step.failed` whose own write fails, parking the run a second time
        // and leaving live state ahead of a row that still says `waiting`.
        // `armWaitingStep` already refuses to arm while paused, so this is
        // what makes the two halves symmetric; the `runReplaced` resume path
        // re-arms from the record when the run is picked back up.
        disarmAllWaitClocks()
        stopHeartbeat(runState.runId)
        return
      }

      // `run.started` is always the first event of a run (runnerActions.ts),
      // so `currentRunId` is set here before anything below — including this
      // same event's own terminal-cleanup line, which never applies to
      // `run.started` itself, and the schedule step a few lines down, which
      // can be the very first thing that registers a controller — can rely
      // on it being current.
      if (event.type === 'run.started') {
        currentRunId = runState.runId
        startHeartbeat(runState.runId, deps, listenerApi.dispatch, listenerApi.getState)
        // Finding 2 (fix round 3): the runner writes the run record
        // imperatively through `RunStore`, never through RTK Query itself, so
        // without this the Past-runs list (`workflowApi`'s own `Runs`-tagged
        // cache) never learns a new run exists until its `keepUnusedDataFor`
        // window happens to lapse.
        listenerApi.dispatch(workflowApi.util.invalidateTags(['Runs']))
      }

      // Bookkeeping cleanup — harmless even on a natural (non-abort) terminal.
      if (isTerminalStepEvent(event)) {
        runnerControllers.abort(event.key)
        // A step that reached a terminal state is no longer waiting on anyone.
        disarmWaitClock(runState.runId, event.key)
        // An island step's bridge closes on every terminal path — a submit that
        // succeeded, an ISLAND_LOAD failure, a skip, or `cancelRun`'s
        // `step.cancelled` (which is also what gives cancel its own teardown
        // reason). A no-op for every other kind.
        void disposeIslandHandle(
          runState.runId,
          event.key,
          event.type === 'step.cancelled' ? 'cancelled' : 'completed',
        )
      }

      if (event.type === 'run.finished') finishRunCleanup(runState.runId, listenerApi.dispatch)

      const after = (listenerApi.getState() as HasRunSlice).run
      const getRunState = () => (listenerApi.getState() as HasRunSlice).run.state ?? undefined

      // A step that just parked on a person (or on an island answering for
      // one) gets its `timeout-minutes` clock — after the write, so a run
      // parked by a persistence failure never starts one.
      if (event.type === 'step.waiting') {
        armWaitingStep(event.key, after, deps, listenerApi.dispatch, getRunState)
      }

      // `armWaitingStep` can fail the step synchronously (`waitClock.ts`'s
      // `remaining <= 0` branch), so the schedule pass below reads `after` —
      // captured before that call — as a stale, pre-fail snapshot. Safe
      // anyway: `handleNextAction` re-checks every proposal against fresh
      // state, and a positive `timeout-minutes` (the schema's own
      // `exclusiveMinimum: 0`) makes `remaining <= 0` unreachable on a step
      // that only just reached `waiting`.
      if (after.mode === 'live' && !after.paused && after.meta && after.state?.status === 'running') {
        for (const a of nextActions(after.meta.def, after.state)) {
          await handleNextAction(a, after.meta.def, after.state, deps, listenerApi.dispatch, getRunState)
        }
      }
    },
  })

  listener.startListening({
    actionCreator: runOpened,
    effect: () => {
      resetRunnerState()
    },
  })

  listener.startListening({
    actionCreator: runReplaced,
    effect: async (action, listenerApi) => {
      const { state, mode } = action.payload

      // Rule (fix round 1, finding 2): resetting is only ever correct when
      // this dispatch is about to become — or already was — the run this
      // tab is actually driving. A `readonly` adoption of some OTHER run
      // (an `openRun`/`takeOver` lease attempt that lost, for a run this tab
      // does not currently drive) must never touch it: `currentRunId` still
      // names the run genuinely being driven, and tearing its controllers/
      // heartbeat/write-queue down here would silently orphan it — steps
      // abort, their terminal events get dropped (`scopedDispatch`'s runId
      // guard), rows sit non-terminal until the lease expires — with no
      // error and no UI signal (exactly what the finding described). The one
      // `readonly` case that *does* still reset is adopting readonly for the
      // SAME run this tab already drives (a lease it just lost, e.g. a
      // missed heartbeat, `runModeChanged`'s sibling path) — that tab
      // genuinely can no longer drive it, so tearing its now-stale
      // controllers/heartbeat down is exactly right. `lifecycleActions.ts`'s
      // `adopt()` carries the same rule one level up (it skips the dispatch
      // entirely rather than reach this point) — this check is the
      // belt-and-suspenders backstop for any other path that might dispatch
      // `runReplaced` without it.
      if (mode === 'readonly' && currentRunId !== null && state.runId !== currentRunId) return

      // A fresh run.started's own `currentRunId` assignment (above) makes
      // this the only other place a run *becomes* current, so it gets the
      // same reset — otherwise a run adopted here would inherit whatever
      // controllers/heartbeat/write-queue a previous run in this tab left
      // behind (05 Resume: "the heartbeat restarts; lease_owner becomes this
      // tab" — only for a `live` adoption; a `readonly` view drives nothing).
      resetRunnerState()
      if (mode !== 'live') return

      currentRunId = state.runId

      // Fail closed (Task 13 review): an output the read path could not fetch
      // arrives as the `{ $file, $error }` sentinel (lib/payloadFetch), and
      // `replayRun` folds it onto the step exactly like a value. Driving the
      // run from here would evaluate every downstream
      // `steps.<key>.outputs.<name>` / `needs.*` against that *object* —
      // silently, all the way to a `run.finished` that persists derived
      // outputs computed from an error marker. There is no honest way to
      // continue, so this tab does not: the reason is recorded on the run
      // (an `error` annotation per unreadable output, which the page renders
      // and the row keeps), the slice is parked, and — crucially — the
      // heartbeat is never started, so the lease this adoption just took
      // lapses on its own and the run stays adoptable once the payload is
      // reachable again. A `readonly` view is unaffected: it returned above,
      // and `ValueView` shows each sentinel as its own "payload unavailable"
      // chip.
      const unloadable = unavailableOutputs(state)
      if (unloadable.length > 0) {
        // Parked *before* the annotations land, so the `runEvent` listener's
        // own schedule pass is already closed when their writes settle
        // (`runEvent` never clears `paused` — only `runReplaced` does).
        listenerApi.dispatch(runPaused(RESUME_REFUSED))
        for (const { stepKey: key, name, error } of unloadable) {
          listenerApi.dispatch(
            runEvent({
              type: 'run.annotation',
              annotation: {
                level: 'error',
                ...(key ? { stepKey: key } : {}),
                message: key
                  ? `step ${key}: output ${name} could not be loaded (${error}) — resume refused; Retry re-reads the run`
                  : `run output ${name} could not be loaded (${error}) — resume refused; Retry re-reads the run`,
              },
              at: deps.clock.now(),
            }),
          )
        }
        return
      }

      startHeartbeat(state.runId, deps, listenerApi.dispatch, listenerApi.getState)

      const getRunState = () => (listenerApi.getState() as HasRunSlice).run.state ?? undefined

      // Resume (05 item 3, Decision 3): a step that was non-terminal when
      // this row's driving tab went away has no scheduler proposal coming —
      // `nextActions` only ever proposes `start` for a key with *no* state
      // yet (next.ts: `itemView` marks an existing non-terminal step
      // `active`, and the scheduler leaves an active item alone). So
      // relaunching those is this listener's job, not the schedule loop's:
      // `polling` resumes the poll loop against its recorded
      // `response.initial`; `queued`/`running` re-issue the whole request
      // (no `resume:` hint in M1); `waiting` needs nothing — the pane
      // re-mounts straight off the replayed state (08). `resumable` above
      // registers every relaunch's controller and builds its `scopedDispatch`
      // the same way for all three kinds.
      const def = (listenerApi.getState() as HasRunSlice).run.meta?.def
      if (def) {
        for (const { step, stepDecl, controller, scoped } of resumable(
          state,
          def,
          'pipeline',
          ['queued', 'running', 'polling'],
          listenerApi.dispatch,
          getRunState,
        )) {
          const rt: StepRuntime = {
            emit: (e) => scoped(runEvent(e)),
            http: deps.http,
            clock: deps.clock,
            signal: controller.signal,
            registerFile: registerFileForStep(deps, state, step.key, scoped, controller.signal),
          }
          // A `polling` row normally resumes poll-only, against the initial
          // response the record kept. Two rows cannot: one whose initial was
          // *stubbed* by `trimResponse` (it blew the 256 KB response budget),
          // and one that never recorded an initial at all (a half-written
          // row, 08). Neither can be polled — the poll's `query`/`body` read
          // `response.<field>` off it — so the step is re-requested from
          // scratch instead (`restart`, pipeline.ts). That is a fact about
          // this run worth recording, not a silent repair: a server-side job
          // may already be running for the initial request whose id the
          // record lost. The notice is stamped with the step so
          // `AnnotationList` can jump to it like any other.
          const initial = step.response?.initial
          const fromScratch =
            step.status === 'polling' && (initial === undefined || isTruncatedStub(initial))
          if (fromScratch) {
            const why =
              initial === undefined
                ? 'its initial response was not recorded'
                : 'its initial response was truncated in the record'
            scoped(
              runEvent({
                type: 'run.annotation',
                annotation: {
                  level: 'notice',
                  stepKey: step.key,
                  message: `step ${step.key} resumed from scratch — ${why}`,
                },
                at: deps.clock.now(),
              }),
            )
          }
          const resume =
            step.status !== 'polling'
              ? undefined
              : fromScratch
                ? { mode: 'restart' as const }
                : { mode: 'poll-only' as const, initial }
          void runPipelineStep(
            {
              step: stepDecl,
              key: step.key,
              job: step.job,
              index: step.index,
              def,
              state,
              ...(resume ? { resume } : {}),
            },
            rt,
          )
        }

        // Islands resume differently from pipelines: nothing is re-requested,
        // because the island *is* the step — a `waiting` row re-opens on the
        // recorded `inputs` (no re-evaluation, Decision 11), and a `running`
        // row (one whose driving tab went away mid-load) re-mounts and reaches
        // `waiting` through the same mount promise a fresh launch uses. The
        // handle is registered here; the pane mounts it as soon as it renders.
        for (const { step, stepDecl, controller, scoped } of resumable(
          state,
          def,
          'island',
          ['waiting', 'running'],
          listenerApi.dispatch,
          getRunState,
        )) {
          // A launch that fails here is a definition bug in a row that already
          // got past its own launch once, and `waiting` has no legal event to
          // record it as — so the step simply has no island to re-open, and the
          // pane says exactly that.
          launchIslandStep({
            step: stepDecl,
            key: step.key,
            job: step.job,
            index: step.index,
            def,
            state,
            signal: controller.signal,
            deps: islandDeps(deps),
            dispatch: listenerApi.dispatch,
            scoped,
            getRunState,
            recordedInputs: step.inputs ?? {},
          })
        }

        // Scripts resume like a `queued`/`running` pipeline, not like an
        // island (Decision 13): the module is re-run from scratch, `with` and
        // all. There is nothing to re-open — a Worker died with the tab that
        // spawned it — and no `resume:` hint to pick a run back up mid-flight,
        // so re-issuing the whole thing is the only honest option. (Which is
        // why 03 asks a script to be idempotent.)
        for (const { step, stepDecl, controller, scoped } of resumable(
          state,
          def,
          'script',
          ['queued', 'running'],
          listenerApi.dispatch,
          getRunState,
        )) {
          launchScriptStep({
            step: stepDecl,
            key: step.key,
            job: step.job,
            index: step.index,
            def,
            state,
            signal: controller.signal,
            deps: scriptDeps(deps),
            registerFile: registerFileForStep(deps, state, step.key, scoped, controller.signal),
            scoped,
            getRunState,
          })
        }

        // The wait clocks, last (Task 9): a row that replayed to `waiting` gets
        // what is *left* of its `timeout-minutes`, measured from the
        // `startedAt` the record kept. After the island loop on purpose — a
        // budget already spent fails the step immediately, and a handle
        // registered after that terminal event would never be disposed.
        for (const step of Object.values(state.steps)) {
          if (step.status !== 'waiting') continue
          armWaitingStep(
            step.key,
            (listenerApi.getState() as HasRunSlice).run,
            deps,
            listenerApi.dispatch,
            getRunState,
          )
        }
      }

      // A resumed run may already be fully resolvable (every job terminal
      // bar the missing `run.finished`, or a not-yet-reached job whose
      // `needs` are already all terminal) with nothing above having emitted
      // anything to trigger the normal `runEvent` listener's own schedule
      // pass — so this listener runs that pass once itself, off the
      // freshest state. Relaunching above *can* emit synchronously (a
      // queued/running relaunch's `runPipelineStep` fires `step.started`
      // before its first await; a poll-only resume fires `step.polling`) —
      // what actually keeps this safe is `nextActions` itself: it only ever
      // proposes `start` for a key with *no* state yet, and every proposal
      // below is re-checked against the freshest state immediately before
      // it dispatches (`handleNextAction`'s own guards), so a step relaunch
      // already emitted above can never be re-proposed here.
      if (def && state.status === 'running') {
        for (const a of nextActions(def, state)) {
          await handleNextAction(a, def, state, deps, listenerApi.dispatch, getRunState)
        }
      }
    },
  })

  listener.startListening({
    actionCreator: runClosed,
    effect: () => {
      resetRunnerState()
    },
  })

  return listener.middleware
}
