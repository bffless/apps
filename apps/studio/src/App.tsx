import { useEffect } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation, Link } from 'react-router-dom'
import { StudioProjects } from './pages/StudioProjects'
import { StudioProjectGuard } from './pages/StudioProjectGuard'

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

/**
 * Minimal app shell. Studio used to mount under the demo site's `<Layout>` at
 * `/studio/*`; standalone it owns the whole app and serves at the root, so this
 * is a thin wordmark bar + `<Outlet>` (pages render their own heroes/steppers).
 */
function Shell() {
  return (
    <div className="flex min-h-svh flex-col">
      <ScrollToTop />
      <header className="sticky top-0 z-40 border-b rule bg-paper/85 backdrop-blur">
        <div className="container-page flex h-14 items-center">
          <Link to="/" className="font-serif text-lg font-semibold text-ink">
            Studio
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
        <Route index element={<StudioProjects />} />
        <Route path="project/:projectId" element={<StudioProjectGuard />} />
        <Route path="project/:projectId/:phase" element={<StudioProjectGuard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default App
