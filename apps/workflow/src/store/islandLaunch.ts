/**
 * Launching an island step (Task 5, Decisions 9–12) — the half of the work the
 * runner middleware cannot do itself.
 *
 * The middleware has no DOM: it can decide *that* an island should be shown,
 * with which arguments, and what its answers mean, but the `<iframe>` belongs
 * to the pane. So the two are joined by a **handle**: the middleware builds the
 * `IslandHost` (wiring `workflow.submit` / `workflow.annotate` /
 * `ui/request-display-mode` back into the run) and parks it here under
 * `<runId>:<stepKey>`; `IslandStepPane` looks it up and hands it the element it
 * just rendered.
 *
 * The handle's `mount` is pre-bound with everything the middleware knows —
 * impl, src, arguments, headless, the step's `AbortController` signal — so the
 * pane cannot get any of it wrong, and it is `mount` that dispatches the step's
 * own `step.waiting` / `step.failed(ISLAND_LOAD)`. That keeps the lifecycle one
 * story told by the runner, rather than one split across a React component
 * (Decision 11).
 *
 * Module-level, like `runnerMiddleware`'s controllers and for the same reason:
 * only one run is ever driven per tab, and the pane needs a lookup that
 * survives its own re-renders. A tiny subscription lets the pane re-render when
 * a handle appears (Resume registers handles from a listener effect, after the
 * page has already rendered) or when a log line lands.
 */
import { createIslandHost, IslandMountAbandoned } from '../islands/IslandHost'
import type { IslandDisplayMode, IslandHost, IslandHostDeps } from '../islands/IslandHost'
import { fetchText, openLink, signFile } from '../islands/hostDeps'
import { annotateEvent, completeIslandStep, islandInputs } from '../lib/runner/adapters/island'
import { headlessMode } from '../lib/runner/headless'
import type { HttpJson } from '../lib/runner/adapters/pipeline'
import type { Definition, RunState, Step, StepKey, StepStatus } from '../lib/runner/types'
import { runEvent } from './runSlice'
import { islandDisplayChanged } from './uiSlice'

/** What `IslandStepPane` needs to mount and label a step's island. */
export interface IslandHandle {
  host: IslandHost
  /**
   * Mount into `iframe`. Pre-bound: the pane supplies the element and nothing
   * else. Never rejects — a failed mount is recorded as the step's own
   * `ISLAND_LOAD` failure, a truer place for it than a React callback.
   */
  mount(iframe: HTMLIFrameElement): Promise<void>
  title: string
  display: IslandDisplayMode
  src: string
  impl: string
  /** The tool `arguments` — and the step's persisted `inputs`, verbatim (Decision 11). */
  arguments: Record<string, unknown>
  headless: boolean
  /**
   * The pane may offer **Accept** (07, apps#432): the step declares
   * `headless: auto` and nobody is driving it already (`headless` is false).
   * Fixed at launch, like `title`.
   */
  acceptable: boolean
  /**
   * Accept was pressed. Read as a `useSyncExternalStore` snapshot by the
   * pane; set once, never cleared — the island is on its way to submitting.
   */
  accepted: boolean
  /**
   * One step, one click: tell the island it is driving itself, exactly as a
   * headless run would have on `ui/initialize` — through a
   * `host-context-changed` carrying `bffless.headless: true` if it is up, or
   * on the handshake if its mount is still in flight (`IslandHost.setHeadless`
   * covers both), and on the mount itself if the pane has not called it yet.
   * Touches nothing on the run: not `unattended`, not `headless`, no row.
   */
  accept(): void
  /**
   * `ui/message` lines. Live only — never persisted (Decision 12). Replaced
   * with a fresh array per line, never pushed to: the pane reads it as a
   * `useSyncExternalStore` snapshot (apps#370).
   */
  log: readonly string[]
}

/**
 * The middleware's `RunnerDeps`, narrowed to what an island needs — passed
 * rather than imported so this module and `runnerMiddleware` don't reference
 * each other's types in a circle.
 */
export interface IslandLaunchDeps {
  http: HttpJson
  now: () => number
  /** Test seam; the app's real store passes `createIslandHost`. */
  islandHost?: (deps: IslandHostDeps) => IslandHost
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const handles = new Map<string, IslandHandle>()
const listeners = new Set<() => void>()

function bump(): void {
  for (const listener of [...listeners]) listener()
}

function handleKey(runId: string, key: StepKey): string {
  return `${runId}:${key}`
}

export function getIslandHandle(runId: string, key: StepKey): IslandHandle | undefined {
  return handles.get(handleKey(runId, key))
}

/** `useSyncExternalStore` subscribe: a registration, a disposal or a log line notifies. */
export function subscribeIslandHandles(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A step reached a terminal state: close its bridge and forget it. */
export async function disposeIslandHandle(
  runId: string,
  key: StepKey,
  reason: 'cancelled' | 'completed',
): Promise<void> {
  const id = handleKey(runId, key)
  const handle = handles.get(id)
  if (!handle) return
  handles.delete(id)
  bump()
  await handle.host.teardown(reason)
}

/**
 * The run went away (closed, replaced, superseded) or this tab stopped driving
 * it (`unmounted`: the record is untouched, the frames are going): nothing may
 * stay live.
 */
export async function disposeAllIslandHandles(
  reason: 'cancelled' | 'completed' | 'unmounted' = 'cancelled',
): Promise<void> {
  const all = [...handles.values()]
  if (all.length === 0) return
  handles.clear()
  bump()
  for (const handle of all) await handle.host.teardown(reason)
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface LaunchIslandArgs {
  step: Step
  key: StepKey
  job: string
  index: number
  def: Definition
  state: RunState
  /** The step's controller signal — `cancelRun`'s `abortAll` reaches the mount through it. */
  signal: AbortSignal
  deps: IslandLaunchDeps
  /** Unscoped: view state (`islandDisplay`) is not run state, and outlives a superseded run. */
  dispatch: (action: unknown) => unknown
  /** Run-scoped (`scopedDispatch`): everything that folds into the record goes through here. */
  scoped: (action: unknown) => unknown
  getRunState: () => RunState | undefined
  /**
   * Resume (Decision 11): the row's recorded `inputs`, delivered verbatim as
   * the tool arguments instead of re-evaluating the step's `with`. The record
   * is the truth (D16) — an expression whose upstream has since changed must
   * not silently re-open the island on different input.
   */
  recordedInputs?: Record<string, unknown>
}

export type LaunchIslandResult = { ok: true; handle: IslandHandle } | { ok: false; error: string }

/**
 * Build the step's host, wire its answers back into the run, and park the
 * handle for the pane. Returns `{ ok: false }` — never throws — when the step's
 * `with` is a definition bug (`islandInputs` throws on a missing `src`), so the
 * caller can record that as the step's failure rather than stalling the run.
 */
export function launchIslandStep(a: LaunchIslandArgs): LaunchIslandResult {
  let inputs
  try {
    inputs = islandInputs({
      step: a.step,
      key: a.key,
      job: a.job,
      index: a.index,
      def: a.def,
      state: a.state,
    })
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }

  const args = a.recordedInputs ?? inputs.arguments

  /**
   * This step's status — but only while the run it belongs to is still the one
   * the slice holds. A step key repeats identically across runs of the same
   * workflow, so without the `runId` check a superseded island could read (and
   * act on) a *different* run's identically-keyed step.
   */
  const liveStatus = (): StepStatus | undefined => {
    const state = a.getRunState()
    if (!state || state.runId !== a.state.runId) return undefined
    return state.steps[a.key]?.status
  }

  /**
   * An island keeps answering until its bridge is closed, and closing happens a
   * persist round-trip *after* the step went terminal — so a second
   * `workflow.submit` (an impatient double click inside the island) can land on
   * an already-succeeded step. The reducer would throw `IllegalTransition` out
   * of `dispatch`; the island gets a plain "too late" instead.
   */
  const OPEN: ReadonlySet<StepStatus> = new Set<StepStatus>(['running', 'waiting'])
  const isOpen = () => {
    const status = liveStatus()
    return status !== undefined && OPEN.has(status)
  }

  const hostDeps: IslandHostDeps = {
    http: a.deps.http,
    fetchText,
    sign: signFile(a.deps.http),
    onSubmit: (outputs) => {
      const state = a.getRunState()
      if (!state || !isOpen()) {
        return { ok: false, errors: { outputs: 'This step is no longer accepting a submit.' } }
      }
      const submitted = completeIslandStep({
        step: a.step,
        key: a.key,
        job: a.job,
        index: a.index,
        def: a.def,
        state,
        outputs,
        at: a.deps.now(),
      })
      if (!submitted.ok) return submitted
      a.scoped(runEvent(submitted.event))
      return { ok: true }
    },
    onAnnotate: (annotateArgs) => {
      // `step.annotated` is legal only on a non-terminal step (reducer.ts), so
      // the same guard the submit path needs applies here.
      if (!isOpen()) return { ok: false, error: 'This step is no longer accepting annotations.' }
      // The budget is per step, so the call is judged against what the row
      // already holds (apps#370).
      const existing = a.getRunState()?.steps[a.key]?.annotations ?? []
      const event = annotateEvent(a.key, annotateArgs, a.deps.now(), existing)
      if ('error' in event) return { ok: false, error: event.error }
      a.scoped(runEvent(event))
      return { ok: true }
    },
    onDisplayMode: (mode) => {
      a.dispatch(islandDisplayChanged(mode))
    },
    onLog: (line) => {
      handle.log = [...handle.log, line]
      bump()
    },
    openLink,
    now: a.deps.now,
  }

  const host = (a.deps.islandHost ?? createIslandHost)(hostDeps)

  // What the island is told through `hostContext.bffless.headless` (07): an
  // unattended run asks a `headless: auto` island to submit by itself exactly
  // as a headless run does — the island code is the same either way, and only
  // ever sees the one flag. (`headlessDecision` has already let the island
  // through, so a declared `auto` is the only way an unattended run reaches
  // this; an undeclared island waits for its person and is told nothing.)
  const selfDriving = a.state.headless || (a.state.unattended && headlessMode(a.step) === 'auto')

  const handle: IslandHandle = {
    host,
    title: inputs.title,
    display: inputs.display,
    src: inputs.src,
    impl: a.state.impl,
    arguments: args,
    headless: selfDriving,
    acceptable: !selfDriving && headlessMode(a.step) === 'auto',
    accepted: false,
    accept() {
      if (!handle.acceptable || handle.accepted) return
      handle.accepted = true
      bump()
      host.setHeadless(true)
    },
    log: [],
    async mount(iframe) {
      try {
        await host.mount(iframe, {
          impl: a.state.impl,
          src: inputs.src,
          arguments: args,
          // `handle.headless` itself stays what it was: the frame remounts on
          // a change to that prop, and Accept must never remount the island.
          headless: selfDriving || handle.accepted,
          signal: a.signal,
        })
      } catch (err) {
        // An abandoned mount is not a failure (`IslandMountAbandoned`): the
        // pane unmounted, the step was cancelled, or a second mount superseded
        // this one — React StrictMode's dev double-mount does the last on every
        // island's first load, and recording that as `ISLAND_LOAD` would fail
        // every island in dev before it ever rendered.
        if (err instanceof IslandMountAbandoned) return
        // Only while the step is still `running`: a resumed `waiting` step
        // whose re-mount failed is a UI problem, not a new run event.
        if (liveStatus() === 'running') {
          a.scoped(
            runEvent({
              type: 'step.failed',
              key: a.key,
              error: { code: 'ISLAND_LOAD', message: messageOf(err) },
              at: a.deps.now(),
            }),
          )
        }
        return
      }
      // The same guard, the other way round: a resumed island is *already*
      // waiting, and a second `step.waiting` would put a transition in the row
      // stream that never happened.
      if (liveStatus() === 'running') {
        a.scoped(runEvent({ type: 'step.waiting', key: a.key, at: a.deps.now() }))
      }
    },
  }

  handles.set(handleKey(a.state.runId, a.key), handle)
  bump()

  // The declared `display` is *not* applied from here, or anywhere at launch:
  // every island starts inline (04, apps#432), and `handle.display` is what
  // the pane reads to decide whether to *offer* the fullscreen overlay. The
  // store stays the single source of truth for the mode, and a background
  // launch in a parallel job never touches it.
  return { ok: true, handle }
}
