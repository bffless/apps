/**
 * The run's Summary (spec 2026-09-08): the graph and the run card, at
 * `/<impl>/<workflow>/runs/<runId>`.
 *
 * Interim — Phase 3 replaces the graph-plus-card with the job list. An old
 * `?step=` on this URL never reaches here: the shell redirects it, because
 * only the shell can do so without racing its own follow logic.
 */
import { GraphView } from '../../components/graph/GraphView'
import { RunPane } from '../../components/run/RunPane'
import { parseStepKey } from '../../lib/runner/types'
import { useRunContext } from './runContext'

export function RunSummaryPage() {
  const ctx = useRunContext()
  return (
    <>
      <GraphView
        def={ctx.def}
        mode="run"
        state={ctx.state}
        selectedKey={null}
        onSelect={(key, side) =>
          ctx.select(parseStepKey(key) ? { kind: 'step', key } : { kind: 'job', job: key }, side)
        }
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
