/**
 * The workflow's YAML with its lint results (08). Stub — the source view lands
 * with the workflow task.
 */
import { useWorkflowListing } from '../store/useWorkflowListing'

export function FilePage() {
  const { listing } = useWorkflowListing()

  return (
    <section className="page">
      <h1 className="page-title">{listing?.file ?? 'Workflow file'}</h1>
      <p className="note">The workflow file view is not built yet.</p>
    </section>
  )
}
