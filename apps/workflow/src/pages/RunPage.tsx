/**
 * One run (08): the record, rebuilt.
 *
 * Nothing on this page is remembered from when the run happened — the page
 * fetches the run row and its step rows and folds them through `replayRun`, the
 * very same engine Resume uses (05). So a run someone else started, in another
 * tab, a week ago, renders exactly like one this tab drove.
 *
 * The run row is **self-describing**: it carries its own definition snapshot,
 * its YAML and its workflow name (D16), so this page never waits on discovery.
 * That matters for a run whose implementation has since been unpublished — the
 * record still opens.
 *
 * Three degraded states are first-class (08): no such run, a run held by
 * another tab (read-only here; the actions arrive in Phase 3), and a row whose
 * definition snapshot cannot be used at all — which still renders as a record.
 */
import { useMemo } from 'react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { useParams } from 'react-router-dom'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { AnnotationList } from '../components/AnnotationList'
import { EmptyState } from '../components/EmptyState'
import { GraphView } from '../components/graph/GraphView'
import { RunHeader } from '../components/run/RunHeader'
import { RunOutputs } from '../components/run/RunOutputs'
import { RunSummary } from '../components/run/RunSummary'
import { StepPane } from '../components/run/StepPane'
import { loadWorkflow } from '../lib/runner/definition'
import { replayRun } from '../lib/runner/replay'
import type { ServerRunRow, ServerStepRow } from '../lib/coerce'
import type { Annotation, Definition, RunState } from '../lib/runner/types'
import { useAppDispatch, useAppSelector } from '../store/hooks'
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

export function RunPage() {
  const { impl, workflow, runId } = useParams()
  const dispatch = useAppDispatch()
  const selectedStep = useAppSelector((state) => state.ui.selectedStep)

  const arg = runId ?? skipToken
  // The cache is read before it is subscribed to, so the polling interval this
  // render passes is decided by the run's *known* status: a finished run never
  // starts a timer, and the one render where the status is still unknown polls
  // no faster than not at all.
  const known = workflowApi.endpoints.getRun.useQueryState(arg)
  const { data, isLoading, isFetching } = useGetRunQuery(arg, {
    pollingInterval: known.data?.run?.status === 'running' ? POLL_MS : 0,
  })

  const run = data?.run ?? null
  const steps = useMemo(() => data?.steps ?? [], [data?.steps])

  const def = useMemo(() => (run ? definitionOf(run) : null), [run])
  const state = useMemo(() => {
    if (!run || !def) return null
    try {
      return replayRun(run, steps, def)
    } catch {
      // A snapshot the engine refuses is a broken record, not a broken page.
      return null
    }
  }, [run, steps, def])

  const annotations = useMemo(() => (state ? collectAnnotations(state) : []), [state])

  if (isLoading || (isFetching && !data)) return <p className="note">Loading…</p>

  if (!run) {
    return (
      <EmptyState title="No such run">
        <p>Nothing was recorded for {runId}. It may have been deleted, or never started.</p>
      </EmptyState>
    )
  }

  const base = `/${impl ?? run.impl}/${workflow ?? run.workflow}`

  return (
    <section className="page">
      <RunHeader
        run={run}
        status={state?.status ?? run.status}
        annotations={annotations}
        base={base}
      />

      {run.status === 'running' && (
        <p className="note">
          This run is still in flight — it is held by the tab driving it, and resumable from here.
          Cancel, Resume and Take over arrive in Phase 3.
        </p>
      )}

      {!state || !def ? (
        <RawRows run={run} steps={steps} />
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
              <StepPane key={selectedStep} def={def} state={state} stepKey={selectedStep} />
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
