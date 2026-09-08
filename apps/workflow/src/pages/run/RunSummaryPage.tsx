/**
 * The run's Summary (spec 2026-09-08): the graph and the run card, at
 * `/<impl>/<workflow>/runs/<runId>`.
 *
 * The graph draws one node per job (Task 8), so every click on it is a job:
 * the step below it is picked on the job's own page.
 *
 * Interim — Phase 3 replaces the graph-plus-card with the job list. An old
 * `?step=` on this URL never reaches here: the shell redirects it, because
 * only the shell can do so without racing its own follow logic.
 */
import { GraphView } from '../../components/graph/GraphView'
import { RunPane } from '../../components/run/RunPane'
import { useRunContext } from './runContext'

export function RunSummaryPage() {
  const ctx = useRunContext()
  return (
    <>
      <GraphView
        def={ctx.def}
        mode="run"
        state={ctx.state}
        selectedJob={ctx.selection.kind === 'job' ? ctx.selection.job : null}
        onSelect={(job, side) => ctx.select({ kind: 'job', job }, side)}
      />
      <RunPane
        key={ctx.state.runId}
        def={ctx.def}
        state={ctx.state}
        workflowName={ctx.workflowName}
        annotations={ctx.annotations}
        impl={ctx.impl}
        onJump={(key) => ctx.select({ kind: 'step', key })}
      />
    </>
  )
}
