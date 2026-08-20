/**
 * The run page's first section (08): what ran, how it ended, and the two ways
 * out of it that exist while the harness is read-only.
 *
 * "View workflow file" carries the run's **own** YAML in the navigation state
 * (D16) rather than linking at the file the implementation publishes now — a
 * run is a record, and what it did is what its snapshot says. Cancel, Resume,
 * Take-over and Delete are Phase 3: an action that cannot be honoured is worse
 * than an action that is not offered yet.
 */
import { Link } from 'react-router-dom'
import { StatusPill } from '../StatusPill'
import { formatDuration } from '../../lib/duration'
import { pluralize } from '../../lib/plural'
import type { ServerRunRow } from '../../lib/coerce'
import type { Annotation, RunStatus } from '../../lib/runner/types'

const LEVELS: Annotation['level'][] = ['error', 'warning', 'notice']

export interface RunHeaderProps {
  run: ServerRunRow
  /** The replayed status; the row's own when the run could not be rebuilt. */
  status: RunStatus
  /** Every annotation of the run, run-level and per step. */
  annotations: Annotation[]
  /** `/<impl>/<workflow>` — the run's screens hang off it. */
  base: string
}

export function RunHeader({ run, status, annotations, base }: RunHeaderProps) {
  // A duration is only a fact once the run has one: a *ticking* elapsed needs a
  // clock, and the clock belongs to the live runner (Phase 3), not to a page
  // whose whole job is to read a record back.
  const finished = run.finishedAt ?? null

  const counts = LEVELS.map((level) => ({
    level,
    count: annotations.filter((annotation) => annotation.level === level).length,
  })).filter((entry) => entry.count > 0)

  return (
    <header className="run-head">
      <div className="run-head-title">
        <h1 className="page-title">{run.workflowName || run.workflow}</h1>
        <span data-testid="run-status" data-state={status}>
          <StatusPill status={status} />
        </span>
      </div>

      <ul className="meta run-meta">
        <li className="run-id">{run.runId}</li>
        {run.startedBy && <li>{run.startedBy}</li>}
        <li>{new Date(run.startedAt).toLocaleString()}</li>
        <li>{finished === null ? 'in flight' : formatDuration(finished - run.startedAt)}</li>
        {run.headless && <li className="badge">headless</li>}
        {counts.map(({ level, count }) => (
          <li className="badge" key={level} data-severity={level}>
            {pluralize(count, level)}
          </li>
        ))}
      </ul>

      <nav className="page-actions">
        <Link to={`${base}/file`} state={{ yaml: run.yaml, runId: run.runId }}>
          View workflow file
        </Link>
        <Link to={`${base}/run?from=${run.runId}`}>Re-run</Link>
      </nav>
    </header>
  )
}
