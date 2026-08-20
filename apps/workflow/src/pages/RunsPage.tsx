/**
 * Past runs of one workflow (08).
 *
 * Everything in a row comes from the **run row alone** — the list endpoint
 * returns no step rows, so the outputs cell counts the run's own outputs.
 * Anything else would mean N+1 fetches to fill a table, which is also why there
 * is no annotations column in M1: annotations live on the *step* rows, so an
 * honest count needs an `annotationCounts` rollup persisted onto the run row at
 * `run.finished` — a write-path change, and therefore Phase 3.
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
import { pluralize } from '../lib/plural'
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
      <h1 className="page-title">Past runs</h1>

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
        <table className="runs-table">
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Status</th>
              <th scope="col">Started by</th>
              <th scope="col">Started</th>
              <th scope="col">Duration</th>
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
                </td>
                <td>{run.startedBy ?? '—'}</td>
                <td>{new Date(run.startedAt).toLocaleString()}</td>
                <td>
                  {run.finishedAt == null ? '—' : formatDuration(run.finishedAt - run.startedAt)}
                </td>
                <td>{outputsCell(run)}</td>
                <td>
                  <Link to={`${base}/run?from=${run.runId}`}>Re-run</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
