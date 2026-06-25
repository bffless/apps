import { useEffect } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation, Link } from 'react-router-dom'
import { HandoffHome } from './pages/HandoffHome'
import { HandoffViewer } from './pages/HandoffViewer'
import { HandoffFolder } from './pages/HandoffFolder'

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
  return (
    <div className="flex min-h-svh flex-col">
      <ScrollToTop />
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/85 backdrop-blur">
        <div className="container-page flex h-14 items-center">
          <Link to="/" className="text-lg font-semibold text-gray-900">
            Handoff
          </Link>
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
