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
import { runPipelineStep } from '../lib/runner/adapters/pipeline'
import type { Clock, HttpJson, StepRuntime } from '../lib/runner/adapters/pipeline'
import { nextActions } from '../lib/runner/next'
import type { NextAction } from '../lib/runner/next'
import { eventToWrites } from '../lib/runner/rows'
import type { PersistWrite, RunRow } from '../lib/runner/rows'
import type { Definition, FileRef, RunEvent, RunState, Step, StepKey } from '../lib/runner/types'
import { disposeAllIslandHandles, disposeIslandHandle, launchIslandStep } from './islandLaunch'
import type { IslandLaunchDeps } from './islandLaunch'
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
}

/** `RunnerDeps`, narrowed to what launching an island actually needs. */
function islandDeps(deps: RunnerDeps): IslandLaunchDeps {
  return {
    http: deps.http,
    now: () => deps.clock.now(),
    ...(deps.islandHost ? { islandHost: deps.islandHost } : {}),
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
    if (!res.ok) throw new Error(`registerFile: files/register answered ${res.status}`)
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
  writeQueues.clear()
  finishing.clear()
  currentRunId = null
  currentGeneration += 1
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
        if (isCurrent) {
          dispatch(runModeChanged('readonly'))
          runnerControllers.abortAll()
        }
        heartbeats.delete(runId)
        return
      }

      if (!result.ok) {
        if (isCurrent) {
          dispatch(runModeChanged('readonly'))
          runnerControllers.abortAll()
        }
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

function stepOf(def: Definition, job: string, stepId: string): Step | undefined {
  return def.jobs[job]?.steps.find((s) => s.id === stepId)
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

/** Wraps `deps.registerFile` with the 06 "outside the run prefix" warning. */
function registerFileForStep(
  deps: RunnerDeps,
  state: RunState,
  key: StepKey,
  dispatch: (action: unknown) => unknown,
): (path: string) => Promise<FileRef> {
  return async (path) => {
    const file = await deps.registerFile(state, key, path)
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
      const step = stepOf(def, a.job, a.stepId)
      if (!step) return

      const controller = new AbortController()
      controllers.set(controllerKey(runState.runId, a.key), controller)

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
          registerFile: registerFileForStep(deps, runState, a.key, scoped),
        }
        void runPipelineStep({ step, key: a.key, job: a.job, index: a.index, def, state: runState }, rt)
      } else if (step.uses === 'form') {
        dispatch(runEvent({ type: 'step.waiting', key: a.key, at: deps.clock.now() }))
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
      } else {
        // `queued -> failed` is not a legal transition (transitions.ts): every
        // kind's failure passes through `running` first, same as a pipeline
        // step's own terminal-failure path (`step.started` then `step.failed`).
        const at = deps.clock.now()
        dispatch(runEvent({ type: 'step.started', key: a.key, inputs: {}, at }))
        dispatch(
          runEvent({
            type: 'step.failed',
            key: a.key,
            error: { code: 'UNSUPPORTED_KIND_M1', message: `${step.uses} steps arrive in M2` },
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

      const writes = eventToWrites(event, { state: runState, runRow: () => rowFromSlice(slice) })
      for (const write of writes) {
        const result = await enqueue(runState.runId, () => persistWrite(deps.runStore, write))
        if (!result.ok) {
          listenerApi.dispatch(runPaused(pauseMessage(event, result.error)))
          runnerControllers.abortAll()
          stopHeartbeat(runState.runId)
          return
        }
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

      if (event.type === 'run.finished') {
        stopHeartbeat(runState.runId)
        writeQueues.delete(runState.runId)
        finishing.delete(runState.runId)
        // Same reasoning as `run.started` above, plus the specific `Run` this
        // finish just patched (`workflowApi.ts`'s `getRun` `providesTags`
        // keys it by run id) — a page already viewing this run's record stays
        // stale otherwise.
        listenerApi.dispatch(
          workflowApi.util.invalidateTags(['Runs', { type: 'Run', id: runState.runId }]),
        )
      }

      const after = (listenerApi.getState() as HasRunSlice).run
      if (after.mode === 'live' && !after.paused && after.meta && after.state?.status === 'running') {
        const getRunState = () => (listenerApi.getState() as HasRunSlice).run.state ?? undefined
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
      // re-mounts straight off the replayed state (08). Every relaunch is
      // registered in the same `controllers` map a scheduler-started step
      // would use, so `cancelRun`'s `runnerControllers.abortAll()` reaches
      // it exactly the same way, and every relaunch's `scopedDispatch` is
      // built the normal way (runId + generation + run-status guarded) so a
      // second adoption of this same run supersedes this one cleanly.
      const def = (listenerApi.getState() as HasRunSlice).run.meta?.def
      if (def) {
        for (const step of Object.values(state.steps)) {
          if (step.kind !== 'pipeline') continue
          if (step.status !== 'queued' && step.status !== 'running' && step.status !== 'polling') continue
          const stepDecl = stepOf(def, step.job, step.stepId)
          if (!stepDecl) continue

          const controller = new AbortController()
          controllers.set(controllerKey(state.runId, step.key), controller)
          const scoped = scopedDispatch(state.runId, listenerApi.dispatch, getRunState)
          const rt: StepRuntime = {
            emit: (e) => scoped(runEvent(e)),
            http: deps.http,
            clock: deps.clock,
            signal: controller.signal,
            registerFile: registerFileForStep(deps, state, step.key, scoped),
          }
          const resume =
            step.status === 'polling'
              ? { mode: 'poll-only' as const, initial: step.response?.initial }
              : undefined
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
        for (const step of Object.values(state.steps)) {
          if (step.kind !== 'island') continue
          if (step.status !== 'waiting' && step.status !== 'running') continue
          const stepDecl = stepOf(def, step.job, step.stepId)
          if (!stepDecl) continue

          const controller = new AbortController()
          controllers.set(controllerKey(state.runId, step.key), controller)
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
            scoped: scopedDispatch(state.runId, listenerApi.dispatch, getRunState),
            getRunState,
            recordedInputs: step.inputs ?? {},
          })
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
