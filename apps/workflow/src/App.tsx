/**
 * The route table (08). Every screen renders inside `Shell`, and the router
 * itself lives in `main.tsx` — so a test can mount `<App/>` in a `MemoryRouter`
 * at any path.
 */
import { Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { FilePage } from './pages/FilePage'
import { ImplementationsPage } from './pages/ImplementationsPage'
import { KickoffPage } from './pages/KickoffPage'
import { RunPage } from './pages/RunPage'
import { RunsPage } from './pages/RunsPage'
import { WorkflowPage } from './pages/WorkflowPage'
import { WorkflowsPage } from './pages/WorkflowsPage'

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<ImplementationsPage />} />
        <Route path=":impl" element={<WorkflowsPage />} />
        <Route path=":impl/:workflow" element={<WorkflowPage />} />
        <Route path=":impl/:workflow/run" element={<KickoffPage />} />
        <Route path=":impl/:workflow/runs" element={<RunsPage />} />
        <Route path=":impl/:workflow/runs/:runId" element={<RunPage />} />
        <Route path=":impl/:workflow/file" element={<FilePage />} />
      </Route>
    </Routes>
  )
}
