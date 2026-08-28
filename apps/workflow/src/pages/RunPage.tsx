/**
 * One run (08): the record, rebuilt — or, while this tab is the one driving
 * it, the live slice itself.
 *
 * A finished run (or one someone else started, in another tab, a week ago) is
 * fetched as its row + step rows and folded through `replayRun`, the very
 * same engine Resume uses (05); nothing on that path is remembered from when
 * the run happened.
 *
 * A run *this* tab is driving is different: the run row that `getRun` would
 * read was written by the very same middleware dispatch that is still
 * in-flight (Task 17's write-ahead persistence), so a `GET` issued the instant
 * `startRun` navigates here can race the row's own `create` — reading it as
 * "no such run" would be inventing a fact the server never gave us, the same
 * reasoning the *read-that-failed* branch below already uses. The live path
 * sidesteps the race by never asking the server in the first place: while
 * `slice.state?.runId` matches the route and `slice.mode === 'live'`, this
 * page renders straight off the run slice (Task 17), no polling, no `getRun`
 * call at all — the graph, the panes and the outputs update the instant an
 * event reduces, and a `waiting` form step opens as its own pane immediately
 * (08: "the pane is the form"), never after a fetch.
 *
 * The run row is **self-describing** on the replayed path: it carries its own
 * definition snapshot, its YAML and its workflow name (D16), so this page
 * never waits on discovery. That matters for a run whose implementation has
 * since been unpublished — the record still opens.
 *
 * Three degraded states are first-class (08) on the replayed path: no such
 * run, a run held by another tab (read-only here; the actions arrive in
 * Phase 3), and a row whose definition snapshot cannot be used at all — which
 * still renders as a record.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { EmptyState } from '../components/EmptyState'
import { LoadError } from '../components/LoadError'
import { GraphView } from '../components/graph/GraphView'
import type { PaneSide } from '../components/graph/GraphView'
import { useIslandHandle } from '../islands/useIslandHandle'
import { PausedBanner } from '../components/run/PausedBanner'
import { RunHeader } from '../components/run/RunHeader'
import { JobPane } from '../components/run/JobPane'
import { RunPane } from '../components/run/RunPane'
import { StepPane } from '../components/run/StepPane'
import { FileRefProvider } from '../components/values/FileRefProvider'
import { ImplContext } from '../components/values/implContext'
import { loadWorkflow } from '../lib/runner/definition'
import { firstStepWhere, firstWaitingStep, stepProgress } from '../lib/runner/graph'
import { replayRun } from '../lib/runner/replay'
import { publishWorkflowGlobal, snapshotOf } from '../lib/workflowGlobal'
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'
import type { Annotation, Definition, RunState, StepKey, StepState } from '../lib/runner/types'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { RunStoreError } from '../lib/runStore'
import { LeaseTransportError, cancelRun, deleteRun, openRun, takeOver } from '../store/lifecycleActions'
import { islandDisplayChanged, stepSelected, valueHovered } from '../store/uiSlice'
import { workflowApi, useGetRunQuery, useWhoamiQuery } from '../store/workflowApi'

/** A run still in flight is a feed; a finished one is a record (05). */
const POLL_MS = 5_000

/** The roles the delete rule lets past its owner check (05 access) — mirrored, never trusted. */
const ADMIN_ROLES = ['admin', 'owner']

/** The query parameter that carries the selected step (08): `?step=<job>/<index>/<step>`. */
const STEP_PARAM = 'step'

/** A run that is no longer in flight. */
const TERMINAL_RUN: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

/** A step that has finished, whatever it finished as — it holds nothing open. */
const TERMINAL_STEP: ReadonlySet<string> = new Set(['succeeded', 'failed', 'skipped', 'cancelled'])

/**
 * A refusal from the delete rule, in the words of the person who asked. The
 * three statuses mean three different things and only one of them is "try
 * again", so a single "couldn't delete" message would hide the fix.
 */
function deleteMessage(error: unknown): string {
  if (error instanceof RunStoreError) {
    if (error.status === 403) return "Only the run's owner or an admin can delete it."
    if (error.status === 409) return 'Cancel the run first, then delete it.'
    if (error.status === 404) return 'This run is already gone.'
  }
  return error instanceof Error ? error.message : 'The run could not be deleted.'
}

/**
 * The definition the run stored, or the one its YAML snapshot parses to.
 * `toDefinition` assumes schema-valid data, so a row written by an older or
 * broken writer is caught here rather than by a crash three components down.
 */
function definitionOf(run: ServerRunRow): Definition | null {
  const raw = run.definition
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    try {
      const def = toDefinition(raw)
      if (Object.keys(def.jobs).length > 0) return def
    } catch {
      // fall through to the YAML snapshot
    }
  }
  return run.yaml ? loadWorkflow(run.yaml, `${run.workflow}.workflow.yaml`).def : null
}

/** Every annotation of the run, each step's stamped with the step it came from. */
function collectAnnotations(state: RunState): Annotation[] {
  return [
    ...state.annotations,
    ...Object.values(state.steps).flatMap((step) =>
      step.annotations.map((annotation) => ({ ...annotation, stepKey: step.key })),
    ),
  ]
}

/**
 * An island whose pane has not opened yet: the pane owns the iframe, so a live
 * island counts from `running`, not `waiting` (Decision 11).
 */
function isLoadingIsland(step: StepState): boolean {
  return step.kind === 'island' && step.status === 'running'
}

/** A row that cannot be replayed is still a row worth reading (08). */
function RawRows({ run, steps }: { run: ServerRunRow; steps: ServerStepRow[] }) {
  return (
    <section className="raw-rows">
      <p className="note">
        This run has no usable definition snapshot, so it is shown as a read-only record.
      </p>
      <h2 className="section-title">Step rows</h2>
      {steps.length === 0 ? (
        <p className="note">No step rows were recorded.</p>
      ) : (
        <ul className="rows">
          {steps.map((step) => (
            <li className="row" key={step.key}>
              <div className="row-head">
                <span className="row-title">{step.key}</span>
                <span className="pill" data-state={step.status}>
                  {step.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <h2 className="section-title">Run inputs</h2>
      <pre className="declaration">{JSON.stringify(run.inputs, null, 2)}</pre>
    </section>
  )
}

/**
 * A `running` row this tab does not hold (08 degraded state): held live by
 * another tab (a heartbeat within the last 60 s) offers a confirm-gated Take
 * over; an expired lease offers Resume outright. Both call into
 * `lifecycleActions.ts`'s adopt-live path — whether they land as `live` or
 * fall back to `readonly` is that thunk's call, not this component's (a
 * takeover race can still lose).
 *
 * `held` is read off the wall clock, so it is computed in an effect rather
 * than at render time (react-hooks/purity, same posture as `RunHeader`'s
 * `useNow`) — it only needs to be *current*, not ticking, since the 5 s poll
 * that drives this component's own re-renders already refreshes `run`. The
 * `setState` itself is deferred through a microtask, same as `useNow`, so the
 * effect body never calls it synchronously (react-hooks/set-state-in-effect).
 *
 * `pending` disables both buttons for the duration of one attempt (fix round
 * 1, finding 1 — `adopt()` itself also guards against a genuinely concurrent
 * double click; this is the visible half of that, and covers the ordinary
 * case of a slow lease round-trip too). `lost` is fix round 1, finding 2's
 * "surface lost-takeover feedback in the UI" ask: an attempt that finishes
 * without this run ending up `live` in the slice — the lease was already
 * gone by the time it landed, or (this tab driving a different run) the
 * adoption was deliberately skipped to avoid disturbing it — reads the same
 * from here, "still not yours," so one message covers both.
 *
 * `failed` (fix round 3, finding 3) is the separate case: the lease
 * *request* itself never got an answer — a network error or a non-2xx from
 * `runStore.lease`, surfaced as `LeaseTransportError` out of `adopt()`. That
 * is not the same fact as "still held elsewhere" (which `lost` reports), so
 * it gets its own message and its own catch — an uncaught rejection here
 * would otherwise both leave `attempt`'s promise unhandled and tell the user
 * something the server never actually said.
 */
function ResumeBanner({ run, steps }: { run: ServerRunRow; steps: ServerStepRow[] }) {
  const dispatch = useAppDispatch()
  const [held, setHeld] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  // Set once an attempt has finished; `lost` below is derived from it plus
  // the slice's *current* mode/runId on every render, never a value
  // captured at click time — the dispatch's own reducer updates land
  // synchronously inside it, so by the render this flips on, the selectors
  // below already read the adoption's real outcome.
  const [attempted, setAttempted] = useState(false)
  const [failed, setFailed] = useState(false)
  const sliceMode = useAppSelector((state) => state.run.mode)
  const sliceRunId = useAppSelector((state) => state.run.state?.runId)

  useEffect(() => {
    queueMicrotask(() => {
      setHeld(Boolean(run.leaseOwner) && typeof run.leaseUntil === 'number' && run.leaseUntil > Date.now())
    })
  }, [run.leaseOwner, run.leaseUntil])

  const args = { runId: run.runId, run, steps }
  const adoptedLive = sliceMode === 'live' && sliceRunId === run.runId
  const lost = attempted && !pending && !adoptedLive && !failed

  async function attempt(thunk: (a: typeof args) => ReturnType<typeof openRun>) {
    setPending(true)
    setFailed(false)
    try {
      await dispatch(thunk(args))
    } catch (err) {
      if (!(err instanceof LeaseTransportError)) throw err
      setFailed(true)
    } finally {
      setPending(false)
      setAttempted(true)
    }
  }

  return (
    <p className="note">
      This run is still in flight — it is held by the tab driving it, and resumable from here.{' '}
      {held === null ? null : held ? (
        <button
          type="button"
          data-testid="run-take-over"
          disabled={pending}
          onClick={() => {
            if (window.confirm('Another tab is driving this run. Take over anyway?')) {
              void attempt(takeOver)
            }
          }}
        >
          Take over
        </button>
      ) : (
        <button type="button" data-testid="run-resume" disabled={pending} onClick={() => void attempt(openRun)}>
          Resume
        </button>
      )}
      {failed && (
        <span className="note" data-testid="run-adopt-failed">
          {' '}
          Couldn&apos;t reach the server — try again.
        </span>
      )}
      {lost && (
        <span className="note" data-testid="run-adopt-lost">
          {' '}
          Could not take this run over — it&apos;s still held elsewhere.
        </span>
      )}
    </p>
  )
}

export function RunPage() {
  const { impl, workflow, runId } = useParams()
  const dispatch = useAppDispatch()
  const navigate = useNavigate()

  // The selection *is* the URL (08, decided 2026-08-26): `?step=<key>` opens
  // that step's pane in place of the run-level card, so a drilled-in view is
  // linkable and the browser's Back button climbs out of a step the way it
  // climbs out of a GitHub job page. It is also what scopes a selection to
  // the run being viewed — a navigation to another run is a different URL,
  // with no `step` on it — which the process-global `ui.selectedStep` never
  // was (fix round 1). Other query parameters (`?mocks=`) ride along untouched.
  // Three levels share the one parameter (08: run › job › step): absent = the
  // run card, a bare job id = that job's card, `job/index/step` = a step's pane.
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedStep: StepKey | null = searchParams.get(STEP_PARAM)
  const level: 'run' | 'job' | 'step' = selectedStep === null ? 'run' : selectedStep.includes('/') ? 'step' : 'job'
  const setStep = (key: StepKey | null, replace: boolean) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (key === null) next.delete(STEP_PARAM)
        else next.set(STEP_PARAM, key)
        return next
      },
      { replace },
    )

  // Who we are, for Delete's owner gate. Advisory only: the rule re-reads
  // `user.*` server-side, so the worst a wrong answer here can do is offer a
  // button the server then refuses.
  const { data: me } = useWhoamiQuery()
  const [deleting, setDeleting] = useState(false)
  const [deleteFailed, setDeleteFailed] = useState<string | null>(null)

  // Which side a graph edge dot asked the pane to open on (08: "jump straight
  // to one side"). A chip click has no side and leaves the pane on Input. The
  // counter makes a second click on the same dot re-open that side even when
  // the selection did not change — the pane is keyed on it below.
  const [side, setSide] = useState<{ key: string; side: PaneSide; n: number } | null>(null)
  /** Up one level: a step's job, a job's run. */
  const back = () => setStep(level === 'step' ? selectedStep!.split('/')[0]! : null, false)
  const toRun = () => setStep(null, false)
  /** A person's click: a history entry, so Back returns to where they were. */
  const select = (key: StepKey, requested?: PaneSide) => {
    // The selected chip (or strip), clicked again with no side asked for, is
    // the way up one level — the same toggle a pressed button suggests.
    if (key === selectedStep && requested === undefined) {
      back()
      return
    }
    setStep(key, false)
    if (requested) setSide((prev) => ({ key, side: requested, n: (prev?.n ?? 0) + 1 }))
  }
  const paneSide = side && side.key === selectedStep ? side : null

  // `ui.selectedStep` is a read-model of the URL, never the other way round:
  // kept for whatever cannot reach the router (tests read it; the hover
  // highlight's owner may). It is written after each change, so it lags the
  // URL by one commit and must not be read to *decide* anything on this page.
  useEffect(() => {
    dispatch(stepSelected(selectedStep))
  }, [selectedStep, dispatch])

  // The hovered value is process-global and step keys repeat identically
  // across runs of the same workflow (fix round 1, finding 1) — a hover left
  // over from the run just navigated away from would highlight a graph chip
  // on the new run that never produced it. (The selection needs no such
  // reset any more: it lives on the URL, which the navigation replaced.)
  useEffect(() => {
    dispatch(valueHovered(null))
  }, [runId, dispatch])

  // The live path (Task 18): this tab is driving `runId` right now.
  const sliceMode = useAppSelector((state) => state.run.mode)
  const sliceMeta = useAppSelector((state) => state.run.meta)
  const sliceState = useAppSelector((state) => state.run.state)
  const isLive = sliceMode === 'live' && sliceMeta !== null && sliceState?.runId === runId
  // The 05 pause (a failed write-ahead write, or a refused resume): only ever
  // set on the run this tab drives, so it is a live-path fact (apps#375).
  const paused = useAppSelector((state) => state.run.paused)

  // Skipped entirely while live — the point of the live path is to never
  // depend on this call, not merely to prefer the slice when it wins a race.
  const arg = isLive ? skipToken : (runId ?? skipToken)
  // The cache is read before it is subscribed to, so the polling interval this
  // render passes is decided by the run's *known* status: a finished run never
  // starts a timer, and the one render where the status is still unknown polls
  // no faster than not at all.
  const known = workflowApi.endpoints.getRun.useQueryState(arg)
  const { data, isLoading, isFetching, isError, error, refetch } = useGetRunQuery(arg, {
    pollingInterval: known.data?.run?.status === 'running' ? POLL_MS : 0,
  })

  const run = data?.run ?? null
  const steps = useMemo(() => data?.steps ?? [], [data?.steps])

  const replayedDef = useMemo(() => (run ? definitionOf(run) : null), [run])
  const replayedState = useMemo(() => {
    if (!run || !replayedDef) return null
    try {
      return replayRun(run, steps, replayedDef)
    } catch {
      // A snapshot the engine refuses is a broken record, not a broken page.
      return null
    }
  }, [run, steps, replayedDef])

  const def = isLive ? sliceMeta!.def : replayedDef
  const state = isLive ? sliceState : replayedState

  const annotations = useMemo(() => (state ? collectAnnotations(state) : []), [state])

  // The observe half of the page contract (07/D12): `window.__workflow` is
  // what a headless driver polls to follow the run it started. Published from
  // whichever state this page is rendering — live slice or replayed record,
  // headless run or not — because the driver's question ("where has it got
  // to?") is the same one this page answers, and a second source of truth for
  // it would be one more thing to keep in step. Cleared when the page goes:
  // a snapshot of a run nobody is showing any more is worse than none.
  useEffect(() => {
    publishWorkflowGlobal(state ? snapshotOf(state) : null)
    return () => publishWorkflowGlobal(null)
  }, [state])

  // A `waiting` step opens as its own pane the moment the run reaches it —
  // first by topo order (08: "the pane is the form") — as long as nothing
  // else is already selected, so a click elsewhere is never fought back over.
  //
  // A live island counts from `running`, not from `waiting`: the pane owns the
  // iframe, so the step cannot *reach* `waiting` until its pane has rendered
  // (Decision 11). Waiting still wins when both exist — an island loading in
  // the background must not steal the pane from a form being filled in.
  const waitingStep = def && state ? firstWaitingStep(def, state) : null
  const loadingIsland =
    isLive && def && state ? firstStepWhere(def, state, isLoadingIsland) : null
  const openStep = waitingStep ?? loadingIsland

  const selectedStepState = level === 'step' && selectedStep && state ? state.steps[selectedStep] : undefined

  // A step that is *itself* mid-interaction: an island whose pane owns the
  // bridge, or a form waiting on the person filling it in. The pane is theirs
  // until they resolve — nothing may take it out from under them.
  const selectionIsInteractive =
    (selectedStepState?.kind === 'island' &&
      (selectedStepState.status === 'running' || selectedStepState.status === 'waiting')) ||
    (selectedStepState?.kind === 'form' && selectedStepState.status === 'waiting')

  // Fix round 4, finding 1: the pane is the *only* thing that mounts an island
  // (Decision 11), so a `running` island whose pane never opens stalls there
  // forever — the 30 s `ISLAND_LOAD` clock only starts at `mount`, and the step
  // offers no affordance of its own. A click on any other step during the run
  // used to do exactly that. So a loading island **claims** the pane, over any
  // selection that is not itself mid-interaction; the one case the original
  // `!selectedStep` guard protected — a form being filled in, or another
  // island already up — still wins, and that island is the one the user sees.
  //
  // The claim is made **once per island** (apps#370). Re-claiming on every
  // click away restarted the ISLAND_LOAD clock with every re-mount, so a
  // hanging island plus a clicking user never timed out — and fought the user
  // for the pane. An island the user has left while loading stays `running`
  // with its chip as the way back; the run header's cancel is the other exit.
  // Any island that has been the selection while loading counts as claimed,
  // whether the page opened it or the user did.
  const claimed = useRef<{ runId: string | null; keys: Set<string> }>({
    runId: null,
    keys: new Set(),
  })
  useEffect(() => {
    if (!state || !def) return
    if (claimed.current.runId !== state.runId) {
      claimed.current = { runId: state.runId, keys: new Set() }
    }
    if (!selectedStep) {
      if (openStep) {
        if (isLoadingIsland(state.steps[openStep]!)) claimed.current.keys.add(openStep)
        // The page's own selection replaces the entry rather than pushing one:
        // Back should leave the run, not step through every auto-open.
        setStep(openStep, true)
      }
      return
    }
    // Only the tab driving the run has a pane to claim: read-only renders the
    // tabs for a `running` island (StepPane's `live` gate), so moving the
    // selection there would just yank the reader around.
    if (!isLive) return
    if (selectedStepState && isLoadingIsland(selectedStepState)) {
      claimed.current.keys.add(selectedStep)
      return
    }
    if (selectionIsInteractive) return
    const claiming = firstStepWhere(
      def,
      state,
      (step) => isLoadingIsland(step) && !claimed.current.keys.has(step.key),
    )
    if (!claiming) return
    claimed.current.keys.add(claiming)
    setStep(claiming, true)
    // `setStep` closes over `setSearchParams`, which react-router keeps stable;
    // listing it would only re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLive, openStep, selectedStep, selectedStepState, selectionIsInteractive, def, state])

  // Nobody clicks in a headless run (07), and the pane is still the only thing
  // that mounts an island (Decision 11) — so the page has to keep an active
  // island in the pane by itself, or the run sits at `running` until its wait
  // budget expires. Deliberately a *second* effect rather than a branch in the
  // claim-once one above: that rule is about not fighting a person for the
  // pane, and it spends its claim per island, which is exactly the budget an
  // unattended run must not depend on. Here there is no person to protect, so
  // the rule is simpler and can re-open the same island as often as it takes.
  //
  // It only ever acts when nothing is selected or the selection has finished:
  // an island or form that is itself still going keeps the pane, so two
  // islands in flight do not take turns evicting each other.
  useEffect(() => {
    if (!isLive || !def || !state || !sliceState?.headless) return
    const selected = selectedStep ? state.steps[selectedStep] : undefined
    if (selected && !TERMINAL_STEP.has(selected.status)) return
    const active = firstStepWhere(
      def,
      state,
      (step) => step.kind === 'island' && (step.status === 'running' || step.status === 'waiting'),
    )
    if (!active || active === selectedStep) return
    // Replace, never push: an auto-open is the page keeping up with the run,
    // not a place anyone navigated to.
    setStep(active, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `setStep` is stable (see above)
  }, [isLive, sliceState, def, state, selectedStep])

  // A live run that just finished returns the page to the run level (08): the
  // results are the reason the person is here, and the step that happened to
  // be open — usually the form they just submitted — is not. Only on the
  // *transition* out of `running`, so a finished run deep-linked with `?step=`
  // opens on that step as asked.
  const runStatus = state?.status
  const previousStatus = useRef<string | undefined>(undefined)
  useEffect(() => {
    const was = previousStatus.current
    previousStatus.current = runStatus
    if (!isLive || runStatus === undefined) return
    if (was === 'running' && TERMINAL_RUN.has(runStatus) && selectedStep) setStep(null, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `setStep` is stable (see above)
  }, [isLive, runStatus, selectedStep])

  // Fullscreen is a mode of the *mounted island*, so it only holds while the
  // selected step really is one (08). Anything else — the run moved on, the
  // user picked another step, the page changed run — puts the page back inline
  // rather than leaving a fixed overlay over a step with no island in it.
  const islandDisplay = useAppSelector((s) => s.ui.islandDisplay)
  const islandOpen =
    isLive &&
    selectedStepState?.kind === 'island' &&
    (selectedStepState.status === 'running' || selectedStepState.status === 'waiting')
  const fullscreen = islandDisplay === 'fullscreen' && islandOpen

  // The mode an island *starts* in is its own declared `display` (04), and this
  // is where that is applied: when the pane opens, not when the step launches.
  // Launching is global — a second island starting in a parallel job would drag
  // the page out from under the one the user is in — and a seed dispatched
  // before the step is selected would be undone by this effect's own reset in
  // the same commit. Seeding once per opened step also leaves the island's
  // `ui/request-display-mode` and the strip's exit button free to move the mode
  // afterwards: neither changes what was seeded, so neither is fought back over.
  const openIslandKey = islandOpen ? selectedStep : null
  const openIslandHandle = useIslandHandle(state?.runId ?? '', openIslandKey ?? '')
  const seededFor = useRef<string | null>(null)
  useEffect(() => {
    if (openIslandKey === null) {
      // Nothing to reset until something was seeded — otherwise this would
      // dispatch `inline` over and over on every unrelated render.
      if (seededFor.current === null) return
      seededFor.current = null
      dispatch(islandDisplayChanged('inline'))
      return
    }
    // The handle can land a render after the selection does (Resume registers
    // handles from a listener effect), and waiting for it is better than
    // seeding `inline` and never revisiting.
    if (!openIslandHandle || seededFor.current === openIslandKey) return
    seededFor.current = openIslandKey
    dispatch(islandDisplayChanged(openIslandHandle.display))
  }, [openIslandKey, openIslandHandle, dispatch])

  if (!isLive && (isLoading || (isFetching && !data && !isError))) {
    return <p className="note">Loading…</p>
  }

  // A read that failed says nothing about whether the run exists — reporting it
  // as "no such run" would invent a fact the server never gave us.
  if (!isLive && isError && !data) {
    return <LoadError title="Couldn't load this run" error={error} onRetry={() => void refetch()} />
  }

  if (!isLive && !run) {
    return (
      <EmptyState title="No such run">
        <p>Nothing was recorded for {runId}. It may have been deleted, or never started.</p>
      </EmptyState>
    )
  }

  const base = isLive
    ? `/${impl ?? sliceState!.impl}/${workflow ?? sliceState!.workflow}`
    : `/${impl ?? run!.impl}/${workflow ?? run!.workflow}`

  const shownRunId = isLive ? sliceState!.runId : run!.runId
  const shownStatus = state?.status ?? run!.status
  // A run this tab started has no `startedBy` in the slice (only a *replayed*
  // one does — `replayRun` carries the row's), and it does not need one: the
  // session that started it is the session reading this.
  const startedBy = isLive ? (sliceState!.startedBy ?? me?.id) : run!.startedBy

  // The affordance mirrors the rule's own gate (05 access), so the button is
  // only ever offered where the answer is likely yes — a refusal is still a
  // normal outcome, and `deleteFailed` below is where it lands.
  const canDelete =
    shownStatus !== 'running' &&
    me !== undefined &&
    (startedBy === me.id || ADMIN_ROLES.includes((me.role ?? '').toLowerCase()))

  async function onDelete() {
    setDeleting(true)
    setDeleteFailed(null)
    try {
      await dispatch(deleteRun({ runId: shownRunId }))
      // Only on success, and only here: the thunk owns the caches, the page
      // owns where to go next (there is no run left to be on).
      void navigate(`${base}/runs`)
    } catch (error) {
      // Deliberately not in a `finally`: the success path has navigated away
      // and this component is gone, so re-enabling the button is the failure
      // path's business alone.
      setDeleteFailed(deleteMessage(error))
      setDeleting(false)
    }
  }

  // `render: island` needs to know which bundle an island file lives in,
  // and this page is the last place that fact is unambiguous.
  return (
    // TODO(apps#364): on the read-only path this trusts the run row's own
    // `impl`, which a member wrote. Safe only while `/w/` forwards one fixed
    // alias — see "Trust boundary" under Islands (M2) in `bffless/README.md`
    // before `targetUrl: alias://` generalises it.
    <ImplContext.Provider value={isLive ? sliceState!.impl : run!.impl}>
      <section className="page">
        <RunHeader
          workflowName={isLive ? sliceMeta!.workflowName : run!.workflowName || run!.workflow}
          runId={shownRunId}
          startedBy={isLive ? undefined : run!.startedBy}
          startedAt={isLive ? sliceState!.startedAt : run!.startedAt}
          finishedAt={isLive ? (sliceState!.finishedAt ?? null) : (run!.finishedAt ?? null)}
          headless={isLive ? sliceState!.headless : run!.headless}
          yaml={isLive ? sliceMeta!.yaml : run!.yaml}
          status={shownStatus}
          annotations={annotations}
          base={base}
          progress={state ? stepProgress(state) : undefined}
          live={isLive}
          onCancel={isLive && state?.status === 'running' ? () => void dispatch(cancelRun()) : undefined}
          onDelete={canDelete ? () => void onDelete() : undefined}
          deleting={deleting}
        />

        {deleteFailed && (
          <p className="note banner" role="alert" data-testid="run-delete-failed">
            {deleteFailed}
          </p>
        )}

        {isLive && paused && <PausedBanner message={paused} />}
        {!isLive && run!.status === 'running' && <ResumeBanner run={run!} steps={steps} />}

        {!state || !def ? (
          <RawRows run={run!} steps={steps} />
        ) : (
          <FileRefProvider state={state}>
            <div className={fullscreen ? 'run-canvas island-fullscreen' : 'run-canvas'}>
              {fullscreen ? (
                // The page's half of `ui/request-display-mode`: the graph
                // collapses to a strip, and leaving is the page's decision, not
                // the island's — the store flips, and the new mode flows back
                // down to the bridge through `IslandFrame`.
                <div className="island-strip">
                  <span className="island-strip-title">{selectedStep}</span>
                  <button
                    type="button"
                    data-testid="island-exit-fullscreen"
                    onClick={() => dispatch(islandDisplayChanged('inline'))}
                  >
                    Exit fullscreen
                  </button>
                </div>
              ) : (
                <GraphView
                  def={def}
                  mode="run"
                  state={state}
                  selectedKey={selectedStep}
                  onSelect={select}
                />
              )}
              {/*
                One level of the taxonomy at a time (08, decided 2026-08-26):
                the run's own card, or — while a step is selected — that
                step's pane in its place. Never both.
              */}
              {level === 'step' ? (
                <StepPane
                  key={`${selectedStep}#${paneSide?.n ?? 0}`}
                  def={def}
                  state={state}
                  stepKey={selectedStep!}
                  live={isLive}
                  initialTab={paneSide?.side}
                  onBack={back}
                  onRun={toRun}
                />
              ) : level === 'job' ? (
                <JobPane
                  key={`${selectedStep}#${paneSide?.n ?? 0}`}
                  def={def}
                  state={state}
                  job={selectedStep!}
                  impl={state.impl}
                  initialTab={paneSide?.side}
                  onSelect={(key) => select(key)}
                  onBack={toRun}
                />
              ) : (
                <RunPane
                  key={state.runId}
                  def={def}
                  state={state}
                  workflowName={isLive ? sliceMeta!.workflowName : run!.workflowName || run!.workflow}
                  annotations={annotations}
                  impl={state.impl}
                  onJump={(key) => select(key)}
                />
              )}
            </div>
          </FileRefProvider>
        )}
      </section>
    </ImplContext.Provider>
  )
}
