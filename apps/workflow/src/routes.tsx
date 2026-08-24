/**
 * The route table (08), shared by `App` (the real `<Routes>` tree) and any
 * test that needs *imperative* navigation (`createMemoryRouter` +
 * `RouterProvider`, e.g. a cross-run navigation test) — kept out of `App.tsx`
 * itself because a file `react-refresh` fast-refreshes may only export
 * components, and `routes` here is a plain route-element tree, not one.
 */
import { Route } from 'react-router-dom'
import { Shell } from './components/Shell'
import { FilePage } from './pages/FilePage'
import { ImplementationsPage } from './pages/ImplementationsPage'
import { KickoffPage } from './pages/KickoffPage'
import { RunPage } from './pages/RunPage'
import { RunsPage } from './pages/RunsPage'
import { WorkflowPage } from './pages/WorkflowPage'
import { WorkflowsPage } from './pages/WorkflowsPage'

export const routes = (
  <Route element={<Shell />}>
    <Route index element={<ImplementationsPage />} />
    <Route path=":impl" element={<WorkflowsPage />} />
    <Route path=":impl/:workflow" element={<WorkflowPage />} />
    <Route path=":impl/:workflow/run" element={<KickoffPage />} />
    <Route path=":impl/:workflow/runs" element={<RunsPage />} />
    <Route path=":impl/:workflow/runs/:runId" element={<RunPage />} />
    <Route path=":impl/:workflow/file" element={<FilePage />} />
  </Route>
)
