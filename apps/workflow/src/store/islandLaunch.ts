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
import { createIslandHost } from '../islands/IslandHost'
import type { IslandDisplayMode, IslandHost, IslandHostDeps } from '../islands/IslandHost'
import { fetchText, openLink } from '../islands/hostDeps'
import { annotateEvent, completeIslandStep, islandInputs } from '../lib/runner/adapters/island'
import type { HttpJson } from '../lib/runner/adapters/pipeline'
import type { Definition, RunState, Step, StepKey } from '../lib/runner/types'
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
  /** `ui/message` lines. Live only — never persisted (Decision 12). */
  log: string[]
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
let version = 0

function bump(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

function handleKey(runId: string, key: StepKey): string {
  return `${runId}:${key}`
}

export function getIslandHandle(runId: string, key: StepKey): IslandHandle | undefined {
  return handles.get(handleKey(runId, key))
}

/** `useSyncExternalStore` pair for the pane: a registration or a log line bumps the version. */
export function subscribeIslandHandles(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function islandHandlesVersion(): number {
  return version
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

/** The run went away (closed, replaced, superseded): nothing may stay live. */
export async function disposeAllIslandHandles(
  reason: 'cancelled' | 'completed' = 'cancelled',
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
  const log: string[] = []
  const statusOf = () => a.getRunState()?.steps[a.key]?.status

  const hostDeps: IslandHostDeps = {
    http: a.deps.http,
    fetchText,
    onSubmit: (outputs) => {
      const state = a.getRunState()
      if (!state) return { ok: false, errors: { outputs: 'This run is no longer live.' } }
      const submitted = completeIslandStep({
        step: a.step,
        key: a.key,
        job: a.job,
        index: a.index,
        def: a.def,
        state,
        outputs,
      })
      if (!submitted.ok) return submitted
      a.scoped(runEvent(submitted.event))
      return { ok: true }
    },
    onAnnotate: (annotateArgs) => {
      const event = annotateEvent(a.key, annotateArgs, a.deps.now())
      if ('error' in event) return { ok: false, error: event.error }
      a.scoped(runEvent(event))
      return { ok: true }
    },
    onDisplayMode: (mode) => {
      a.dispatch(islandDisplayChanged(mode))
    },
    onLog: (line) => {
      log.push(line)
      bump()
    },
    openLink,
    now: a.deps.now,
  }

  const host = (a.deps.islandHost ?? createIslandHost)(hostDeps)

  const handle: IslandHandle = {
    host,
    title: inputs.title,
    display: inputs.display,
    src: inputs.src,
    impl: a.state.impl,
    arguments: args,
    headless: a.state.headless,
    log,
    async mount(iframe) {
      try {
        await host.mount(iframe, {
          impl: a.state.impl,
          src: inputs.src,
          arguments: args,
          headless: a.state.headless,
          signal: a.signal,
        })
      } catch (err) {
        // Only while the step is still `running`: a mount abandoned because the
        // step was cancelled (the abort *is* what rejected it) has already been
        // recorded as `step.cancelled`, and a resumed `waiting` step whose
        // re-mount failed is a UI problem, not a new run event.
        if (statusOf() === 'running') {
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
      if (statusOf() === 'running') {
        a.scoped(runEvent({ type: 'step.waiting', key: a.key, at: a.deps.now() }))
      }
    },
  }

  handles.set(handleKey(a.state.runId, a.key), handle)
  bump()

  // The step's declared `display` seeds the page's mode, so the store stays the
  // single source of truth for it — an island that opens fullscreen can still
  // be left fullscreen through the strip's own exit button.
  a.dispatch(islandDisplayChanged(inputs.display))

  return { ok: true, handle }
}
