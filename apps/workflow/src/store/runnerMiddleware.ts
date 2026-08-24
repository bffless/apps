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
import { getOwnerId } from './runnerActions'
import { runClosed, runEvent, runModeChanged, runOpened, runPaused, runReplaced } from './runSlice'
import type { RunSliceState } from './runSlice'

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
  controllers.clear()
  writeQueues.clear()
  finishing.clear()
  currentRunId = null
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

  void (async () => {
    for (;;) {
      try {
        await deps.clock.sleep(HEARTBEAT_MS, controller.signal)
      } catch {
        return
      }
      if (controller.signal.aborted) return

      let result: { ok: boolean }
      try {
        result = await deps.runStore.lease(runId, owner)
      } catch {
        result = { ok: false }
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

      if (!result.ok) {
        if (isCurrent) {
          dispatch(runModeChanged('readonly'))
          runnerControllers.abortAll()
        }
        heartbeats.delete(runId)
        return
      }

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
        const rt: StepRuntime = {
          emit: (e) => dispatch(runEvent(e)),
          http: deps.http,
          clock: deps.clock,
          signal: controller.signal,
          registerFile: registerFileForStep(deps, runState, a.key, dispatch),
        }
        void runPipelineStep({ step, key: a.key, job: a.job, index: a.index, def, state: runState }, rt)
      } else if (step.uses === 'form') {
        dispatch(runEvent({ type: 'step.waiting', key: a.key, at: deps.clock.now() }))
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
      }

      // Bookkeeping cleanup — harmless even on a natural (non-abort) terminal.
      if (isTerminalStepEvent(event)) runnerControllers.abort(event.key)

      if (event.type === 'run.finished') {
        stopHeartbeat(runState.runId)
        writeQueues.delete(runState.runId)
        finishing.delete(runState.runId)
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
    effect: (action, listenerApi) => {
      // A fresh run.started's own `currentRunId` assignment (above) makes
      // this the only other place a run *becomes* current, so it gets the
      // same reset — otherwise a run adopted here would inherit whatever
      // controllers/heartbeat/write-queue a previous run in this tab left
      // behind (05 Resume: "the heartbeat restarts; lease_owner becomes this
      // tab" — only for a `live` adoption; a `readonly` view drives nothing).
      resetRunnerState()
      if (action.payload.mode === 'live') {
        currentRunId = action.payload.state.runId
        startHeartbeat(action.payload.state.runId, deps, listenerApi.dispatch, listenerApi.getState)
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
