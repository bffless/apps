/**
 * The run's Summary (spec 2026-09-08): the graph and the run card, at
 * `/<impl>/<workflow>/runs/<runId>`.
 *
 * Interim — Phase 3 replaces the graph-plus-card with the job list. What it
 * already owns is the redirect: an old `?step=` on the Summary URL (a link
 * someone saved, or a `?step=` typed in) belongs on the job page now, and
 * `redirectFor` says where.
 */
import { Navigate, useLocation } from 'react-router-dom'
import { GraphView } from '../../components/graph/GraphView'
import { RunPane } from '../../components/run/RunPane'
import { parseStepKey } from '../../lib/runner/types'
import { redirectFor } from '../../lib/runRoutes'
import { useRunContext } from './runContext'

export function RunSummaryPage() {
  const ctx = useRunContext()
  const { search } = useLocation()
  const redirect = redirectFor(ctx.base, ctx.runId, new URLSearchParams(search))
  if (redirect) return <Navigate to={redirect} replace />
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
