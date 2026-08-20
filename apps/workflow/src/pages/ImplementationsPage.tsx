/**
 * The front door (08): every alias that answered discovery, as a card.
 *
 * A deployment that published something unusable stays on the list carrying its
 * error — a broken publish nobody can see is worse than one they can (06) — but
 * it carries no links, because there is nothing behind them.
 */
import { Link } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { pluralize } from '../lib/plural'
import type { Implementation } from '../lib/coerce'
import { useDiscoverQuery } from '../store/workflowApi'

/** Where "how do I publish one?" is answered. */
const PUBLISHING_DOC =
  'https://github.com/bffless/apps/blob/main/apps/workflow/docs/spec/06-discovery-publishing-files.md'

function ImplementationCard({ impl }: { impl: Implementation }) {
  return (
    <article className="card">
      <header className="card-head">
        {impl.error ? (
          <span className="card-title">{impl.alias}</span>
        ) : (
          <Link className="card-title" to={`/${impl.alias}`}>
            {impl.alias}
          </Link>
        )}
        {impl.preview && <span className="badge">preview</span>}
      </header>

      {impl.error ? (
        <EmptyState title="This deployment did not publish a usable workflow index">
          <p className="empty-detail">{impl.error}</p>
        </EmptyState>
      ) : (
        <>
          <p className="card-name">{impl.name}</p>
          {impl.description && <p className="card-desc">{impl.description}</p>}
          <ul className="meta">
            {impl.version && <li>v{impl.version}</li>}
            <li>{pluralize(impl.workflows.length, 'workflow')}</li>
          </ul>
        </>
      )}
    </article>
  )
}

export function ImplementationsPage() {
  const { data: implementations, isLoading } = useDiscoverQuery()

  if (isLoading) return <p className="note">Looking for implementations…</p>

  if (!implementations?.length) {
    return (
      <EmptyState title="No implementations found">
        <p>
          A deployment becomes an implementation when its build publishes a workflow bundle to{' '}
          <code>.bffless/workflows/</code>.{' '}
          <a href={PUBLISHING_DOC} target="_blank" rel="noreferrer">
            How to publish one
          </a>
        </p>
      </EmptyState>
    )
  }

  return (
    <section className="cards" data-testid="implementations">
      {implementations.map((impl) => (
        <ImplementationCard key={impl.alias} impl={impl} />
      ))}
    </section>
  )
}
