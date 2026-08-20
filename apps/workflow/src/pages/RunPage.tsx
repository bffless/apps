/**
 * One run: the graph in run mode, its step panes, summary and outputs (08).
 * Stub — the run view lands with the runs task; `run-status` and `run-outputs`
 * are already the contract testids (07), reporting an as-yet unread status.
 */
import { useParams } from 'react-router-dom'

export function RunPage() {
  const { runId } = useParams()

  return (
    <section className="page">
      <h1 className="page-title">Run {runId}</h1>
      <span className="pill" data-testid="run-status" data-state="unknown">
        Unknown
      </span>
      <p className="note">The run view is not built yet.</p>
      <section data-testid="run-outputs" />
    </section>
  )
}
