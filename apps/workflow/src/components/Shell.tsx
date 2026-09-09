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
import { Outlet, useLocation } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'
import { ImplementationRail } from './ImplementationRail'
import { TopBar } from './TopBar'

export function Shell() {
  // Keying the boundary on the path makes navigation a reset: a screen that
  // threw is not still throwing on the next route, and the user always has a
  // way out of the failure card.
  const { pathname } = useLocation()

  return (
    <div className="shell">
      <TopBar />
      <div className="shell-body">
        <ImplementationRail />
        <main className="content">
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  )
}
