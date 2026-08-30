/**
 * Past runs of one workflow (08).
 *
 * Everything in a row comes from the **run row alone** — the list endpoint
 * returns no step rows, so the outputs cell counts the run's own outputs.
 * Anything else would mean N+1 fetches to fill a table. The annotations column
 * is that constraint made good rather than worked around: annotations live on
 * the *step* rows, so the count comes from the `annotationCounts` rollup the
 * write path persists onto the run row at `run.finished` (Task 20), and a row
 * written before that column existed shows an em dash instead of three zeroes
 * it would be inventing. "Waiting on <step>" (apps#473) is the other step-level
 * fact here, and it comes the other way: the list endpoint joins the keys of a
 * run's `waiting` step rows onto the run record at list time (`waitingOn`),
 * and the step's name is resolved from the definition the row already carries
 * — still one query, still nothing persisted.
 *
 * The status filter is client-side (Decision 6): a workflow's runs are a short
 * list, and filtering in the browser keeps one cached query instead of one per
 * filter value.
 */
import { skipToken } from '@reduxjs/toolkit/query/react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { LoadError } from '../components/LoadError'
import { StatusPill } from '../components/StatusPill'
import { formatDuration } from '../lib/duration'
import { isFileRef } from '../components/values/fileRef'
import { ANNOTATION_LEVELS } from '../lib/annotations'
import { pluralize } from '../lib/plural'
import { waitingSteps } from '../lib/waitingOn'
import type { ServerRunRow } from '../lib/coerce'
import type { RunStatus } from '../lib/runner/types'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { runsStatusFilterChanged } from '../store/uiSlice'
import { useListRunsQuery } from '../store/workflowApi'

const FILTERS: (RunStatus | 'all')[] = ['all', 'running', 'succeeded', 'failed', 'cancelled']

const LABELS: Record<RunStatus | 'all', string> = {
  all: 'All statuses',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/**
 * All three levels, zeroes included, so the column is scannable down its own
 * width: a row where only the middle badge is non-zero reads as "warnings" at a
 * glance, which a variable number of badges would not.
 */
function AnnotationCountsCell({ run }: { run: ServerRunRow }) {
  const counts = run.annotationCounts
  if (!counts) return <>—</>
  return (
    <span className="run-annotations" data-testid="run-annotations">
      {ANNOTATION_LEVELS.map((level) => (
        <span className={`badge badge-${level}`} key={level} title={pluralize(counts[level], level)}>
          {counts[level]}
        </span>
      ))}
    </span>
  )
}

/**
 * "waiting on review +1" — where a running run is parked (apps#473), linked to
 * that step on the run page (`?step=` arrives pinned, 08). Only a *running* run
 * waits: a finished run's rows are a record, whatever status they were left in.
 * Several steps can wait at once (parallel matrix items, independent jobs), so
 * the first in scheduling order is named and the rest are counted.
 */
function WaitingOn({ run, base }: { run: ServerRunRow; base: string }) {
  if (run.status !== 'running') return null
  const steps = waitingSteps(run)
  if (steps.length === 0) return null
  const [first, ...more] = steps
  return (
    <span className="run-waiting" data-testid="run-waiting">
      waiting on{' '}
      <Link to={`${base}/runs/${run.runId}?step=${first.key}`} title={first.key}>
        {first.label}
      </Link>
      {more.length > 0 && (
        <span className="run-waiting-more" title={more.map((step) => step.label).join(', ')}>
          {' '}
          +{more.length}
        </span>
      )}
    </span>
  )
}

/** "3 outputs · poster.png" — the count, and the first file among them (08). */
function outputsCell(run: ServerRunRow): string {
  const values = Object.values(run.outputs ?? {})
  if (values.length === 0) return '—'
  const file = values.find(isFileRef)
  return `${pluralize(values.length, 'output')}${file ? ` · ${file.name}` : ''}`
}

export function RunsPage() {
  const { impl, workflow } = useParams()
  const dispatch = useAppDispatch()
  const filter = useAppSelector((state) => state.ui.runsStatusFilter)

  const { data: runs, isLoading, isError, error, refetch } = useListRunsQuery(
    impl && workflow ? { impl, workflow } : skipToken,
  )

  const base = `/${impl}/${workflow}`
  const shown = (runs ?? []).filter((run) => filter === 'all' || run.status === filter)

  return (
    <section className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Past runs</h1>
          <p className="page-sub">
            Every run of this workflow, newest first.{' '}
            <Link to={`${base}/run`}>Start a run</Link>
          </p>
        </div>
      <div className="filters">
        <label className="filter" htmlFor="runs-status">
          Status
        </label>
        <select
          id="runs-status"
          value={filter}
          onChange={(event) =>
            dispatch(runsStatusFilterChanged(event.target.value as RunStatus | 'all'))
          }
        >
          {FILTERS.map((value) => (
            <option key={value} value={value}>
              {LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      </div>

      {isLoading && <p className="note">Loading…</p>}

      {/* A list that failed to load is not a workflow that has never run. */}
      {isError && !runs && (
        <LoadError title="Couldn't load runs" error={error} onRetry={() => void refetch()} />
      )}

      {!isLoading && !isError && (runs ?? []).length === 0 && (
        <EmptyState title="No runs yet">
          <p>
            Nothing has run this workflow. <Link to={`${base}/run`}>Start a run</Link>
          </p>
        </EmptyState>
      )}

      {!isLoading && !isError && (runs ?? []).length > 0 && shown.length === 0 && (
        <EmptyState title="No runs with that status" />
      )}

      {shown.length > 0 && (
        <div className="panel table-panel">
        <table className="runs-table">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Status</th>
              <th scope="col">Started by</th>
              <th scope="col">Started</th>
              <th scope="col">Duration</th>
              <th scope="col">Annotations</th>
              <th scope="col">Outputs</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((run) => (
              <tr key={run.runId}>
                <td>
                  <Link to={`${base}/runs/${run.runId}`}>{run.runId}</Link>
                </td>
                <td>
                  <StatusPill status={run.status} />
                  <WaitingOn run={run} base={base} />
                </td>
                <td>{run.startedBy ?? '—'}</td>
                <td>{new Date(run.startedAt).toLocaleString()}</td>
                <td>
                  {run.finishedAt == null ? '—' : formatDuration(run.finishedAt - run.startedAt)}
                </td>
                <td>
                  <AnnotationCountsCell run={run} />
                </td>
                <td>{outputsCell(run)}</td>
                <td>
                  <Link to={`${base}/run?from=${run.runId}`}>Re-run</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </section>
  )
}
