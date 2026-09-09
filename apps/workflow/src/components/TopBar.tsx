import { Link, useLocation } from 'react-router-dom'
import { useWhoamiQuery } from '../store/workflowApi'

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

/** `runs/run_1/job/greet/1` → `runs`, `run_1`, `greet`, `item 2` — the `job` segment is a route word, not a place. */
function crumbsAfterWorkflow(rest: string[]): string[] {
  const out: string[] = []
  rest.forEach((segment, i) => {
    if (segment === 'job') return
    if (rest[i - 1] === 'job') out.push(decodeURIComponent(segment))
    else if (rest[i - 2] === 'job' && /^\d+$/.test(segment)) out.push(`item ${Number(segment) + 1}`)
    else out.push(segment)
  })
  return out
}

/**
 * `/hello/hello/runs/run_1` → the crumbs above it, each linking to its screen.
 *
 * Read off the *path*, not from `useParams`: the bar renders inside the layout
 * route, which matches before its children and so sees none of their params —
 * `runId`, `job` and the rest are simply not there to read.
 */
function Breadcrumb() {
  const [impl, workflow, ...rest] = useLocation().pathname.split('/').filter(Boolean)

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link to="/">Implementations</Link>
      {impl && <Link to={`/${impl}`}>{impl}</Link>}
      {workflow && <Link to={`/${impl}/${workflow}`}>{workflow}</Link>}
      {crumbsAfterWorkflow(rest).map((segment, index) => (
        <span key={`${index}-${segment}`}>{segment}</span>
      ))}
    </nav>
  )
}

export function TopBar() {
  return (
    <header className="shell-header">
      <Link className="brand" to="/">
        <span className="brand-mark" aria-hidden="true" />
        Workflow
      </Link>
      <span className="shell-divider" aria-hidden="true" />
      <Breadcrumb />
      <Whoami />
    </header>
  )
}
