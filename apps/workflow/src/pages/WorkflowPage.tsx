/**
 * One workflow in definition mode: the graph, "Start a run" and recent runs (08).
 * Stub — the screen itself lands with the graph view; the links are here so the
 * routes below it are reachable in the meantime.
 */
import { Link } from 'react-router-dom'
import { useWorkflowListing } from '../store/useWorkflowListing'

export function WorkflowPage() {
  const { listing } = useWorkflowListing()

  return (
    <section className="page">
      <h1 className="page-title">{listing?.name ?? 'Workflow'}</h1>
      <p className="note">The workflow graph is not built yet.</p>
      <nav className="page-actions">
        <Link to="run">Start a run</Link>
        <Link to="runs">Past runs</Link>
        <Link to="file">View workflow file</Link>
      </nav>
    </section>
  )
}
