/**
 * The router (08). Every screen renders inside `Shell`, and the router
 * instance itself lives in `main.tsx` — so a test can mount `<App/>` in a
 * `MemoryRouter` at any path. The route table lives in `./routes` (a
 * `react-refresh` constraint: this file may only export components).
 */
import { Routes } from 'react-router-dom'
import { routes } from './routes'

export default function App() {
  return <Routes>{routes}</Routes>
}
