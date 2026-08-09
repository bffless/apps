import { Routes, Route, Navigate } from 'react-router-dom'
import { RequireAdmin } from './components/RequireAdmin'
import { AdminVideos } from './pages/AdminVideos'
import { AdminVideo } from './pages/AdminVideo'
import { Home } from './pages/Home'

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
