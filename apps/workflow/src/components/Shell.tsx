/**
 * The frame every screen renders inside (08): a 56px top bar with the app
 * mark, a mono breadcrumb and the signed-in user, and a left rail holding the
 * implementation → workflow tree that discovery found. (The user was M1's one
 * gap here — the harness had no endpoint for one, R8; Task 19's `whoami` rule
 * is it.)
 *
 * The breadcrumb is read off the path rather than from `useParams`, because a
 * layout route matches before its children and so sees none of their params.
 */
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import { LastRunPill } from './LastRunPill'
import { workflowId } from '../lib/coerce'
import { useDiscoverQuery, useWhoamiQuery } from '../store/workflowApi'

function Rail() {
  const { data: implementations, isLoading, isError } = useDiscoverQuery()

  if (isLoading) return <p className="rail-note">Loading…</p>
  // Distinct from "nothing published": a failed alias list says nothing about
  // what this project has (08). The pages carry the detail; the rail is 15rem.
  if (isError) return <p className="rail-note">Couldn't reach the server</p>
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
                    <LastRunPill impl={impl.alias} workflow={workflowId(listing.file)} glyphOnly />
                    <span className="rail-workflow-name">{listing.name}</span>
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

/**
 * Who you are, as the harness sees you. The email when there is one, the id
 * otherwise (an API-key caller has no email) — and nothing at all until the
 * answer lands, because a placeholder identity is worse than none: this is the
 * same fact the run page's Delete gate is read against.
 */
function Whoami() {
  const { data: me } = useWhoamiQuery()
  if (!me) return null
  return (
    <span className="whoami" data-testid="whoami">
      {me.email ?? me.id}
    </span>
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
  // Keying the boundary on the path makes navigation a reset: a screen that
  // threw is not still throwing on the next route, and the user always has a
  // way out of the failure card.
  const { pathname } = useLocation()

  return (
    <div className="shell">
      <header className="shell-header">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true" />
          Workflow
        </Link>
        <span className="shell-divider" aria-hidden="true" />
        <Breadcrumb />
        <Whoami />
      </header>
      <div className="shell-body">
        <nav className="rail" aria-label="Implementations">
          <p className="rail-eyebrow">Implementations</p>
          <Rail />
        </nav>
        <main className="content">
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
