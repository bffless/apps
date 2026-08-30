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
 *
 * The selection either **follows** the run or is **pinned** (apps#452). It
 * starts following — a waiting form opens as its pane, a loading island
 * claims it once (apps#370), a finished run returns to the run card — and
 * stops the moment the person picks something: a chip, a crumb, Esc, a
 * `?step=` they typed or stepped Back to. From then on nothing here moves
 * the selection; the header's "Follow run" toggle is the way back. The one
 * thing that must keep happening while pinned is the run itself: an island
 * that drives itself (07 unattended / `auto-accept`) still has to be
 * *mounted* to do so (Decision 11), so it is mounted **backstage** — in the
 * document, out of sight — rather than by taking the pane.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { LoadError } from '../components/LoadError'
import { GraphView } from '../components/graph/GraphView'
import type { PaneSide } from '../components/graph/GraphView'
import { PausedBanner } from '../components/run/PausedBanner'
import { RunHeader } from '../components/run/RunHeader'
import { JobPane } from '../components/run/JobPane'
import { RunPane } from '../components/run/RunPane'
import { StepPane } from '../components/run/StepPane'
import { FileRefProvider } from '../components/values/FileRefProvider'
import { ImplContext } from '../components/values/implContext'
import { IslandFrame } from '../islands/IslandFrame'
import { useIslandFrameHost, useIslandHandle } from '../islands/useIslandHandle'
import { definitionOf } from '../lib/runDefinition'
import { loadWorkflow } from '../lib/runner/definition'
import { firstStepWhere, firstWaitingStep, forkTarget, stepProgress } from '../lib/runner/graph'
import { replayRun } from '../lib/runner/replay'
import { publishWorkflowGlobal, snapshotOf } from '../lib/workflowGlobal'
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'
import type { Annotation, RunState, StepKey, StepState } from '../lib/runner/types'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { LeaseTransportError, cancelRun, forkRun, openRun, takeOver } from '../store/lifecycleActions'
import { getIslandHandle, subscribeIslandHandles } from '../store/islandLaunch'
import { followChanged, islandDisplayChanged, stepSelected, valueHovered } from '../store/uiSlice'
import { useRunDelete } from '../store/useRunDelete'
import { useWorkflowListing } from '../store/useWorkflowListing'
import { workflowApi, useGetRunQuery, useGetWorkflowYamlQuery, useWhoamiQuery } from '../store/workflowApi'

/** A run still in flight is a feed; a finished one is a record (05). */
const POLL_MS = 5_000

/** The query parameter that carries the selected step (08): `?step=<job>/<index>/<step>`. */
const STEP_PARAM = 'step'

/** A run that is no longer in flight. */
const TERMINAL_RUN: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

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

/** An island whose bridge is (or is about to be) open: it has a frame to mount. */
function isActiveIsland(step: StepState): boolean {
  return step.kind === 'island' && (step.status === 'running' || step.status === 'waiting')
}

/**
 * An island mounted out of sight (apps#452): the pane is the only thing that
 * mounts an island (Decision 11), and while the person has pinned the pane
 * elsewhere — or is mid-interaction in it — a self-driving island (07:
 * unattended, or the step's own `auto-accept:`) would otherwise sit at
 * `running` with nobody to open it. So the page keeps it mounted here, in the
 * document but visually hidden and `inert`, where it loads, submits by itself
 * and finishes exactly as it would in the pane. The same handle, the same
 * frame, the same host adapter as the pane's (`useIslandFrameHost`): moving
 * the selection onto it later is a re-mount from the handle, as leaving any
 * island and coming back always was.
 *
 * Only an island *told* it is driving itself (`handle.headless`, fixed at
 * launch) is mounted here — the page picks those (below) and this checks
 * again off the live handle. One that waits for a person is left to its
 * chip: mounting it hidden would only have it reload under them when they
 * open it.
 */
function BackstageIsland({ runId, stepKey }: { runId: string; stepKey: StepKey }) {
  const handle = useIslandHandle(runId, stepKey)
  const host = useIslandFrameHost(handle)
  if (!handle || !host || !handle.headless) return null
  return (
    <IslandFrame
      impl={handle.impl}
      src={handle.src}
      arguments={handle.arguments}
      headless={handle.headless}
      display="inline"
      title={handle.title}
      host={host}
      // The handle records a failed mount as the step's own `ISLAND_LOAD`
      // failure and resolves, so this never fires (as in `IslandStepPane`).
      onLoadError={() => {}}
    />
  )
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
 * takeover race can still lose). Each branch's copy also says where Cancel
 * will be once the lease is taken — the run header, which offers it the
 * moment the adoption lands `live` — rather than duplicating it here
 * (apps#474).
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
      {held === null ? null : held ? (
        <>
          Another tab is driving this run. Take over to drive it — you can cancel it from the run header afterwards.{' '}
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
        </>
      ) : (
        <>
          This run is still in flight and nobody is driving it. Resume to take over — you can cancel it from the run
          header afterwards.{' '}
          <button type="button" data-testid="run-resume" disabled={pending} onClick={() => void attempt(openRun)}>
            Resume
          </button>
        </>
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

  // Follow or pinned (apps#452). The store holds the answer *for this run*;
  // with none yet (a fresh page, or the page just moved to another run — it
  // never remounts on a `:runId` change) the URL decides: a `?step=` someone
  // arrived with is a choice, an empty one is not. Read synchronously, so the
  // very first render — and every effect below that reads `follow` — is
  // already right; the effect after it only records that default so later
  // changes have an entry to flip.
  const followEntry = useAppSelector((s) => s.ui.follow)
  const follow = runId !== undefined && followEntry?.runId === runId ? followEntry.on : selectedStep === null
  useEffect(() => {
    if (runId === undefined) return
    dispatch(followChanged({ runId, on: follow }))
    // Once per run: the default is derived above; after this the person's
    // actions (and the effect below) own the entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, dispatch])
  /** The person picked something: the selection is theirs now. */
  const pin = () => {
    if (runId !== undefined) dispatch(followChanged({ runId, on: false }))
  }

  // Every selection the *page* makes goes through `write`, which remembers the
  // key so the effect below can tell it from one the person made — a `?step=`
  // typed into the address bar, or stepped Back to — which pins, exactly as a
  // click would. A `null` never pins: Back out to the run level is not a
  // choice of step, and following resumes from there.
  const pageWrote = useRef<StepKey | null | undefined>(undefined)
  const write = (key: StepKey | null, replace: boolean) => {
    pageWrote.current = key
    setStep(key, replace)
  }
  useEffect(() => {
    const own = pageWrote.current !== undefined && pageWrote.current === selectedStep
    pageWrote.current = undefined
    if (own || selectedStep === null || runId === undefined) return
    dispatch(followChanged({ runId, on: false }))
  }, [selectedStep, runId, dispatch])

  // Who we are: the owner half of Delete's gate lives in `useRunDelete`, but
  // a run *this* tab started carries no `startedBy` of its own (see below).
  const { data: me } = useWhoamiQuery()

  // Which side a graph edge dot asked the pane to open on (08: "jump straight
  // to one side"). A chip click has no side and leaves the pane on Input. The
  // counter makes a second click on the same dot re-open that side even when
  // the selection did not change — the pane is keyed on it below.
  const [side, setSide] = useState<{ key: string; side: PaneSide; n: number } | null>(null)
  /** Up one level: a step's job, a job's run. A person's move, so it pins. */
  const back = () => {
    pin()
    setStep(level === 'step' ? selectedStep!.split('/')[0]! : null, false)
  }
  const toRun = () => {
    pin()
    setStep(null, false)
  }
  /** A person's click: a history entry, so Back returns to where they were — and pinned from here on. */
  const select = (key: StepKey, requested?: PaneSide) => {
    // The selected chip (or strip), clicked again with no side asked for, is
    // the way up one level — the same toggle a pressed button suggests.
    if (key === selectedStep && requested === undefined) {
      back()
      return
    }
    pin()
    setStep(key, false)
    if (requested) setSide((prev) => ({ key, side: requested, n: (prev?.n ?? 0) + 1 }))
  }
  /** The header's toggle. Following again means catching up: from a clean selection, the page's own rules pick the step. */
  const onFollowChange = (on: boolean) => {
    if (runId === undefined) return
    dispatch(followChanged({ runId, on }))
    if (on && selectedStep !== null) write(null, true)
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

  // The run on screen, whichever path it came from — and with it the workflow
  // it belongs to. Both the slice and the row are self-describing (D16), so a
  // deep link to a run of an implementation the route does not name still knows
  // where "Past runs" is. Read before the guards below because `useRunDelete`
  // is a hook and cannot be called after them.
  const shown = isLive ? sliceState : run
  const base = `/${impl ?? shown?.impl}/${workflow ?? shown?.workflow}`
  const shownStatus = state?.status ?? run?.status
  // A run this tab started has no `startedBy` in the slice (only a *replayed*
  // one does — `replayRun` carries the row's), and it does not need one: the
  // session that started it is the session reading this.
  const del = useRunDelete({
    runId: shown?.runId,
    status: shownStatus,
    startedBy: isLive ? (sliceState?.startedBy ?? me?.id) : run?.startedBy,
    onDeleted: () => void navigate(`${base}/runs`),
  })

  // Fork — "Re-run from this job" (05; apps#491). A fork runs under the
  // alias's **current** definition, not the parent's snapshot (decision 2), so
  // the page loads it exactly as the kickoff page does — discovery, the file,
  // `loadWorkflow` — and offers the control only once it has. A run whose
  // implementation has since been unpublished still opens as a record (D16);
  // it just cannot be forked from here, since there is no current definition
  // to fork under. The refusal is keyed by run: this page never remounts on a
  // `:runId` change, and a refusal on one run is not a fact about the next.
  const { impl: currentImpl, listing } = useWorkflowListing()
  const { data: currentYaml } = useGetWorkflowYamlQuery(
    currentImpl && listing ? { impl: currentImpl.alias, file: listing.file } : skipToken,
  )
  const current = useMemo(
    () => (currentYaml !== undefined && listing ? loadWorkflow(currentYaml, listing.file) : null),
    [currentYaml, listing],
  )
  const forking = useRef(false)
  const [forkFailed, setForkFailed] = useState<{ runId: string; message: string } | null>(null)

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
  //
  // All of it only while the selection **follows** the run (apps#452): once
  // the person has pinned a step, neither a waiting form nor a loading island
  // moves it — the chip is the way to either, and the header's toggle is the
  // way back to following. (A self-driving island that must mount regardless
  // goes backstage below, not through here.)
  const claimed = useRef<{ runId: string | null; keys: Set<string> }>({
    runId: null,
    keys: new Set(),
  })
  useEffect(() => {
    if (!state || !def) return
    if (claimed.current.runId !== state.runId) {
      claimed.current = { runId: state.runId, keys: new Set() }
    }
    if (!follow) return
    if (!selectedStep) {
      if (openStep) {
        if (isLoadingIsland(state.steps[openStep]!)) claimed.current.keys.add(openStep)
        // The page's own selection replaces the entry rather than pushing one:
        // Back should leave the run, not step through every auto-open.
        write(openStep, true)
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
    write(claiming, true)
    // `write` closes over `setSearchParams`, which react-router keeps stable,
    // and a ref; listing it would only re-run this effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, isLive, openStep, selectedStep, selectedStepState, selectionIsInteractive, def, state])

  // A live run that just finished returns the page to the run level (08): the
  // results are the reason the person is here, and the step that happened to
  // be open — usually the form they just submitted — is not. Only on the
  // *transition* out of `running`, so a finished run deep-linked with `?step=`
  // opens on that step as asked — and only while following (apps#452): a
  // pinned selection stays pinned, finished run or not.
  const runStatus = state?.status
  const previousStatus = useRef<string | undefined>(undefined)
  useEffect(() => {
    const was = previousStatus.current
    previousStatus.current = runStatus
    if (!isLive || runStatus === undefined) return
    if (follow && was === 'running' && TERMINAL_RUN.has(runStatus) && selectedStep) write(null, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `write` is stable (see above)
  }, [follow, isLive, runStatus, selectedStep])

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

  // Every island **starts inline** (04, apps#432): a `display: fullscreen`
  // declaration is the island's *preferred enlarged mode*, offered as the
  // pane's Expand control, never its first mount — jumping straight into an
  // overlay on a chip click read as a new page, and exiting it loses nothing
  // (the mode is a size, not a capability). So the store is put back to
  // `inline` whenever the open island changes (a different step, or none):
  // one dispatch per change, never on unrelated renders, and never fought
  // back over afterwards — the island's own `ui/request-display-mode` and the
  // pane's Expand / Exit are free to move it once it is open.
  const openIslandKey = islandOpen ? selectedStep : null

  // The backstage (apps#452): every island with an open bridge that the pane
  // is *not* showing and whose handle says it drives itself, mounted by
  // `BackstageIsland`. Nobody clicks in a headless run (07), and the pane is
  // the only thing that mounts an island (Decision 11), so without this an
  // unattended run whose person pinned the pane elsewhere — or is filling in
  // a form the page rightly refuses to take from them — sits at `running`
  // until its wait budget expires. The one case where keeping the run moving
  // outranks the pane a person has open, and the trade they made when they
  // ticked "Don't wait for me" or the step said `auto-accept:` (apps#435).
  //
  // Deliberately not while the selection follows the run *and* is free to
  // move: there the claim-once effect above is about to put that island in
  // the pane itself, and mounting it here first would only have it torn down
  // and re-mounted a commit later.
  //
  // The handles live in a module registry, not the store, so the self-driving
  // filter is read through a subscription (as `useIslandHandle` does): a
  // handle Resume registers after the page has rendered still gets its frame.
  // The snapshot is the key list as one string — equal lists read equal, so
  // the subscription never re-renders for nothing.
  const backstageCandidates = useMemo(
    () =>
      isLive && state && (!follow || selectionIsInteractive)
        ? Object.values(state.steps)
            .filter((step) => isActiveIsland(step) && step.key !== openIslandKey)
            .map((step) => step.key)
        : [],
    [isLive, state, follow, selectionIsInteractive, openIslandKey],
  )
  const backstageRunId = state?.runId
  const backstageKeys = useSyncExternalStore(subscribeIslandHandles, () =>
    backstageRunId === undefined
      ? ''
      : backstageCandidates
          .filter((key) => getIslandHandle(backstageRunId, key)?.headless === true)
          .join('\n'),
  )
  const backstage = backstageKeys === '' ? [] : backstageKeys.split('\n')

  const resetFor = useRef<string | null>(null)
  useEffect(() => {
    if (resetFor.current === openIslandKey) return
    resetFor.current = openIslandKey
    dispatch(islandDisplayChanged('inline'))
  }, [openIslandKey, dispatch])

  // Esc leaves the overlay (04). Listened for on the window, because the
  // pane's own `onKeyDown` cannot hear a key pressed inside the sandboxed
  // frame — and when it can (focus on the strip), Esc must mean "exit
  // fullscreen" before it means "up one level".
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      dispatch(islandDisplayChanged('inline'))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [fullscreen, dispatch])

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

  // Past the guards above, exactly one of the two paths is showing a run.
  const shownRunId = shown!.runId

  // The run's own YAML snapshot (D16), for the panes' in-place YAML drawer
  // (apps#449) — the same text the header's "View workflow file" carries.
  const yamlSource = {
    yaml: isLive ? sliceMeta!.yaml : run!.yaml,
    workflowVersion: isLive ? sliceMeta!.workflowVersion : run!.workflowVersion,
    fileHref: `${base}/file`,
  }

  // The fork, offered per job on the job card (decision 5) and only when the
  // stricter client-side question says yes (`forkTarget`: not running, every
  // job outside the pick's downstream closure `success`/`skipped`) — never for
  // the run this tab is driving, and never before the current workflow has
  // loaded. The rule's own gate answers last: a refusal arrives as a
  // `RunStoreError` carrying its reason, shown beside Delete's. On success
  // `forkRun` has already adopted the new run into this tab, so the navigation
  // lands on the live path, the way a kickoff does.
  const forkable = (job: string): boolean =>
    !isLive &&
    def !== null &&
    state !== null &&
    current?.ok === true &&
    current.def !== null &&
    currentImpl !== undefined &&
    forkTarget(def, state, job).ok
  const fork = async (job: string) => {
    if (forking.current || !forkable(job) || !current?.def || !currentImpl) return
    forking.current = true
    setForkFailed(null)
    try {
      const id = await dispatch(
        forkRun({
          runId: shownRunId,
          job,
          def: current.def,
          yaml: current.yaml,
          workflowVersion: currentImpl.version,
          unattended: run!.unattended ?? false,
        }),
      )
      void navigate(`${base}/runs/${id}`)
    } catch (error) {
      setForkFailed({
        runId: shownRunId,
        message: error instanceof Error ? error.message : 'The run could not be forked.',
      })
    } finally {
      forking.current = false
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
          forkedFrom={
            isLive
              ? sliceMeta!.forkedFrom
              : run!.forkedFrom && run!.forkJob
                ? { runId: run!.forkedFrom, job: run!.forkJob }
                : undefined
          }
          finishedAt={isLive ? (sliceState!.finishedAt ?? null) : (run!.finishedAt ?? null)}
          headless={isLive ? sliceState!.headless : run!.headless}
          unattended={isLive ? sliceState!.unattended : (run!.unattended ?? false)}
          yaml={isLive ? sliceMeta!.yaml : run!.yaml}
          status={shownStatus!}
          annotations={annotations}
          base={base}
          progress={state ? stepProgress(state) : undefined}
          live={isLive}
          onCancel={isLive && state?.status === 'running' ? () => void dispatch(cancelRun()) : undefined}
          onDelete={del.onDelete}
          deleting={del.deleting}
          follow={follow}
          onFollowChange={shownStatus === 'running' ? onFollowChange : undefined}
        />

        {del.failed && (
          <p className="note banner" role="alert" data-testid="run-delete-failed">
            {del.failed}
          </p>
        )}
        {forkFailed?.runId === shownRunId && (
          <p className="note banner" role="alert" data-testid="run-fork-failed">
            {forkFailed.message}
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
                <div className="island-strip" data-testid="island-strip">
                  <span className="island-strip-title">
                    <span className="island-strip-crumb">Run › {selectedStep!.split('/')[0]}</span>
                    <span className="island-strip-key">{selectedStep}</span>
                  </span>
                  <button
                    type="button"
                    data-testid="island-exit-fullscreen"
                    onClick={() => dispatch(islandDisplayChanged('inline'))}
                  >
                    Exit fullscreen <kbd>Esc</kbd>
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
                  source={yamlSource}
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
                  onFork={forkable(selectedStep!) ? () => void fork(selectedStep!) : undefined}
                  source={yamlSource}
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
              {backstage.length > 0 && (
                <div className="island-backstage" data-testid="island-backstage" aria-hidden="true" inert>
                  {backstage.map((key) => (
                    <BackstageIsland key={key} runId={state.runId} stepKey={key} />
                  ))}
                </div>
              )}
            </div>
          </FileRefProvider>
        )}
      </section>
    </ImplContext.Provider>
  )
}
