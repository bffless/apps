/**
 * The workflows one implementation published (08): what each one takes, how big
 * it is, whether it can run headless, and how its last run went.
 */
import { Link } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { LastRunPill } from '../components/LastRunPill'
import { workflowId } from '../lib/coerce'
import { pluralize } from '../lib/plural'
import { useWorkflowListing } from '../store/useWorkflowListing'

export function WorkflowsPage() {
  const { impl, isLoading } = useWorkflowListing()

  if (isLoading) return <p className="note">Loading…</p>

  if (!impl) {
    return (
      <EmptyState title="No such implementation">
        <p>
          Nothing published a workflow index here. <Link to="/">Back to implementations</Link>
        </p>
      </EmptyState>
    )
  }

  if (impl.error) {
    return (
      <EmptyState title="This deployment did not publish a usable workflow index">
        <p className="empty-detail">{impl.error}</p>
      </EmptyState>
    )
  }

  if (impl.workflows.length === 0) {
    return <EmptyState title="This implementation published no workflows" />
  }

  return (
    <section className="page">
      <h1 className="page-title">{impl.name}</h1>
      <ul className="rows" data-testid="workflow-list">
        {impl.workflows.map((listing) => {
          const id = workflowId(listing.file)
          return (
            <li className="row" key={listing.file}>
              <div className="row-head">
                <Link className="row-title" to={`/${impl.alias}/${id}`}>
                  {listing.name}
                </Link>
                <LastRunPill impl={impl.alias} workflow={id} />
              </div>
              {listing.description && <p className="row-desc">{listing.description}</p>}
              <ul className="meta">
                <li>{pluralize(listing.inputs, 'input')}</li>
                <li>{pluralize(listing.jobs, 'job')}</li>
                {listing.headlessSafe && <li className="badge">headless-safe</li>}
              </ul>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
