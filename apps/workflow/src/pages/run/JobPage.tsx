/**
 * One job of a run (spec 2026-09-08), at `/job/:job` — `/job/:job/:index` for
 * one item of a matrix — with `?step=<key>` opening that step's pane.
 *
 * Interim: for now it renders exactly what the one-page run rendered, the job
 * card and (when a step is selected) the step's pane. Phase 3 replaces both
 * with the step list and the expanded row.
 */
import { Navigate, useParams, useSearchParams } from 'react-router-dom'
import { JobPane } from '../../components/run/JobPane'
import { StepPane } from '../../components/run/StepPane'
import { parseStepKey } from '../../lib/runner/types'
import { STEP_PARAM, TAB_PARAM, stepPath } from '../../lib/runRoutes'
import { useRunContext } from './runContext'

export function JobPage() {
  const ctx = useRunContext()
  const { job = '' } = useParams()
  const [search] = useSearchParams()
  const step = search.get(STEP_PARAM)
  const tab = search.get(TAB_PARAM) === 'Output' ? 'Output' : search.get(TAB_PARAM) === 'Input' ? 'Input' : undefined
  const parts = step ? parseStepKey(step) : null
  // A `?step=` of another job belongs on that job's page (spec §Error states).
  if (parts && parts.job !== job) return <Navigate to={stepPath(ctx.base, ctx.runId, step!)} replace />
  return (
    <>
      <JobPane
        key={`${job}#${tab ?? ''}`}
        def={ctx.def}
        state={ctx.state}
        job={job}
        impl={ctx.impl}
        initialTab={tab}
        onSelect={(key) => ctx.select({ kind: 'step', key })}
        onBack={ctx.toRun}
        onFork={ctx.forkable(job) ? () => void ctx.fork(job) : undefined}
        source={ctx.yamlSource}
      />
      {parts && (
        <StepPane
          key={step!}
          def={ctx.def}
          state={ctx.state}
          stepKey={step!}
          impl={ctx.impl}
          live={ctx.isLive}
          initialTab={tab}
          onBack={ctx.back}
          onRun={ctx.toRun}
          source={ctx.yamlSource}
        />
      )}
    </>
  )
}
