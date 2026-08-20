/**
 * The frame every screen renders inside (08): a header with the app title and a
 * breadcrumb, and a left rail holding the implementation → workflow tree that
 * discovery found. No user display in M1 — the harness has no endpoint for one
 * (R8).
 *
 * The breadcrumb is read off the path rather than from `useParams`, because a
 * layout route matches before its children and so sees none of their params.
 */
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { workflowId } from '../lib/coerce'
import { useDiscoverQuery } from '../store/workflowApi'

function Rail() {
  const { data: implementations, isLoading } = useDiscoverQuery()

  if (isLoading) return <p className="rail-note">Loading…</p>
  if (!implementations?.length) return <p className="rail-note">No implementations</p>

  return (
    <ul className="rail-tree">
      {implementations.map((impl) => (
        <li key={impl.alias}>
          {impl.error ? (
            <span className="rail-impl is-error">{impl.name}</span>
          ) : (
            <NavLink className="rail-impl" to={`/${impl.alias}`} end>
              {impl.name}
            </NavLink>
          )}
          {impl.workflows.length > 0 && (
            <ul className="rail-workflows">
              {impl.workflows.map((listing) => (
                <li key={listing.file}>
                  <NavLink className="rail-workflow" to={`/${impl.alias}/${workflowId(listing.file)}`}>
                    {listing.name}
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}

/** `/hello/hello/runs/run_1` → the crumbs above it, each linking to its screen. */
function Breadcrumb() {
  const [impl, workflow, ...rest] = useLocation().pathname.split('/').filter(Boolean)

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link to="/">Implementations</Link>
      {impl && <Link to={`/${impl}`}>{impl}</Link>}
      {workflow && <Link to={`/${impl}/${workflow}`}>{workflow}</Link>}
      {rest.map((segment, index) => (
        <span key={`${index}-${segment}`}>{segment}</span>
      ))}
    </nav>
  )
}

export function Shell() {
  return (
    <div className="shell">
      <header className="shell-header">
        <Link className="brand" to="/">
          Workflow
        </Link>
        <Breadcrumb />
      </header>
      <div className="shell-body">
        <nav className="rail" aria-label="Implementations">
          <Rail />
        </nav>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
