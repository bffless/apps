import { useEffect } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation, Link } from 'react-router-dom'
import { HandoffHome } from './pages/HandoffHome'
import { HandoffViewer } from './pages/HandoffViewer'
import { HandoffFolder } from './pages/HandoffFolder'
import { ShareLinkEntry } from './pages/ShareLinkEntry'
import { useSession, adminLoginUrl } from './lib/session'

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

/**
 * Minimal app shell. Handoff owns the whole app at root, so this is a thin
 * sticky wordmark bar + `<Outlet>` (pages render their own content below).
 */
function Shell() {
  const { session, loading } = useSession()

  return (
    <div className="flex min-h-svh flex-col">
      <ScrollToTop />
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/85 backdrop-blur">
        <div className="container-page flex h-14 items-center justify-between">
          <Link to="/" className="text-lg font-semibold text-gray-900">
            Handoff
          </Link>
          <div className="flex items-center gap-3">
            {!loading && session?.authenticated && (
              <>
                <span className="text-sm text-gray-600">{session.user.email}</span>
                <a
                  href="/_bffless/auth/logout"
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Sign out
                </a>
              </>
            )}
            {!loading && !session?.authenticated && (
              <button
                type="button"
                onClick={() => {
                  window.location.href = adminLoginUrl(window.location.href)
                }}
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}

function App() {
  return (
    <Routes>
      {/* /s/:token — public share-link entry, no auth required, no Shell chrome */}
      <Route path="s/:token" element={<ShareLinkEntry />} />
      <Route element={<Shell />}>
        <Route index element={<HandoffHome />} />
        <Route path="view/:id" element={<HandoffViewer />} />
        <Route path="folder/:id" element={<HandoffFolder />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default App
