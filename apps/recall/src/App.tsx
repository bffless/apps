import { Routes, Route, Navigate } from 'react-router-dom'
import { RequireAdmin } from './components/RequireAdmin'
import { AdminVideos } from './pages/AdminVideos'
import { AdminVideo } from './pages/AdminVideo'

/**
 * Placeholder home page. Recall is scaffolding-only at this stage (bffless/apps
 * Task 2) — the real search/chat UI lands in later tasks.
 */
function Home() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Recall
      </h1>
      <p className="text-slate-500 dark:text-slate-400">Video transcript RAG search & chat.</p>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route index element={<Home />} />
      <Route
        path="admin"
        element={
          <RequireAdmin>
            <AdminVideos />
          </RequireAdmin>
        }
      />
      <Route
        path="admin/video/:videoId"
        element={
          <RequireAdmin>
            <AdminVideo />
          </RequireAdmin>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
