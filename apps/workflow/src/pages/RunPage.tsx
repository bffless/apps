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
import { useEffect, useMemo, useState } from 'react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { useParams } from 'react-router-dom'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { AnnotationList } from '../components/AnnotationList'
import { EmptyState } from '../components/EmptyState'
import { LoadError } from '../components/LoadError'
import { GraphView } from '../components/graph/GraphView'
import { RunHeader } from '../components/run/RunHeader'
import { RunOutputs } from '../components/run/RunOutputs'
import { RunSummary } from '../components/run/RunSummary'
import { StepPane } from '../components/run/StepPane'
import { loadWorkflow } from '../lib/runner/definition'
import { firstWaitingStep, stepProgress } from '../lib/runner/graph'
import { replayRun } from '../lib/runner/replay'
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'
import type { Annotation, Definition, RunState } from '../lib/runner/types'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { cancelRun, openRun, takeOver } from '../store/lifecycleActions'
import { stepSelected } from '../store/uiSlice'
import { workflowApi, useGetRunQuery } from '../store/workflowApi'

/** A run still in flight is a feed; a finished one is a record (05). */
const POLL_MS = 5_000

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
  const sliceMode = useAppSelector((state) => state.run.mode)
  const sliceRunId = useAppSelector((state) => state.run.state?.runId)

  useEffect(() => {
    queueMicrotask(() => {
      setHeld(Boolean(run.leaseOwner) && typeof run.leaseUntil === 'number' && run.leaseUntil > Date.now())
    })
  }, [run.leaseOwner, run.leaseUntil])

  const args = { runId: run.runId, run, steps }
  const adoptedLive = sliceMode === 'live' && sliceRunId === run.runId
  const lost = attempted && !pending && !adoptedLive

  async function attempt(thunk: (a: typeof args) => ReturnType<typeof openRun>) {
    setPending(true)
    try {
      await dispatch(thunk(args))
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
  const selectedStep = useAppSelector((state) => state.ui.selectedStep)

  // Selection is scoped to the run being viewed (fix round 1): `uiSlice.
  // selectedStep` is process-global and step keys repeat identically across
  // runs of the same workflow (`<job>/<index>/<step>`, no `runId` component)
  // — and this page never remounts across a run-to-run navigation
  // (react-router keeps the same `RunPage` instance for a `:runId` param
  // change, there is no `key` forcing a fresh one). Left uncleared, a
  // selection made on the run just left would survive onto the next one and
  // block *that* run's own waiting-step auto-select below (`!selectedStep`).
  useEffect(() => {
    dispatch(stepSelected(null))
  }, [runId, dispatch])

  // The live path (Task 18): this tab is driving `runId` right now.
  const sliceMode = useAppSelector((state) => state.run.mode)
  const sliceMeta = useAppSelector((state) => state.run.meta)
  const sliceState = useAppSelector((state) => state.run.state)
  const isLive = sliceMode === 'live' && sliceMeta !== null && sliceState?.runId === runId

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

  // A `waiting` step opens as its own pane the moment the run reaches it —
  // first by topo order (08: "the pane is the form") — as long as nothing
  // else is already selected, so a click elsewhere is never fought back over.
  const waitingStep = def && state ? firstWaitingStep(def, state) : null
  useEffect(() => {
    if (waitingStep && !selectedStep) dispatch(stepSelected(waitingStep))
  }, [waitingStep, selectedStep, dispatch])

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

  return (
    <section className="page">
      <RunHeader
        workflowName={isLive ? sliceMeta!.workflowName : run!.workflowName || run!.workflow}
        runId={isLive ? sliceState!.runId : run!.runId}
        startedBy={isLive ? undefined : run!.startedBy}
        startedAt={isLive ? sliceState!.startedAt : run!.startedAt}
        finishedAt={isLive ? (sliceState!.finishedAt ?? null) : (run!.finishedAt ?? null)}
        headless={isLive ? sliceState!.headless : run!.headless}
        yaml={isLive ? sliceMeta!.yaml : run!.yaml}
        status={state?.status ?? run!.status}
        annotations={annotations}
        base={base}
        progress={state ? stepProgress(state) : undefined}
        live={isLive}
        onCancel={isLive && state?.status === 'running' ? () => void dispatch(cancelRun()) : undefined}
      />

      {!isLive && run!.status === 'running' && <ResumeBanner run={run!} steps={steps} />}

      {!state || !def ? (
        <RawRows run={run!} steps={steps} />
      ) : (
        <>
          <div className="run-canvas">
            <GraphView
              def={def}
              mode="run"
              state={state}
              selectedKey={selectedStep}
              onSelect={(key) => dispatch(stepSelected(key))}
            />
            {selectedStep ? (
              <StepPane key={selectedStep} def={def} state={state} stepKey={selectedStep} live={isLive} />
            ) : (
              <p className="note">Pick a step to see what went in and what came out.</p>
            )}
          </div>

          <RunOutputs def={def} state={state} />
          <RunSummary def={def} state={state} />
          <AnnotationList
            annotations={annotations}
            onJump={(key) => dispatch(stepSelected(key))}
          />
        </>
      )}
    </section>
  )
}
