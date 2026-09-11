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
 * Not every row here is a run. A run that was dispatched and has not been
 * picked up yet has no run row at all — the list endpoint stands its
 * unconsumed claim up as a `queued` entry (apps#671, spec 11 §Attribution), so
 * the window between "start" and the driver's first write stops being blind.
 * Such a row knows only who asked and when: everything else is an em dash, and
 * Re-run is hidden, because a kickoff prefilled from a run that does not exist
 * would open empty.
 *
 * The status filter is client-side (Decision 6): a workflow's runs are a short
 * list, and filtering in the browser keeps one cached query instead of one per
 * filter value. The "All runs" toggle beside it is NOT: whose runs these are is
 * the server's decision (spec 11 D27), and the list that comes back is the
 * answer to an ask the request carried.
 */
import { skipToken } from '@reduxjs/toolkit/query/react'
import { useCallback, useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState } from '../components/EmptyState'
import { LoadError } from '../components/LoadError'
import { StatusPill } from '../components/StatusPill'
import { formatDuration } from '../lib/duration'
import { isFileRef } from '../components/values/fileRef'
import { ANNOTATION_LEVELS } from '../lib/annotations'
import { pluralize } from '../lib/plural'
import { stepPath } from '../lib/runRoutes'
import { waitingSteps } from '../lib/waitingOn'
import { isQueuedRun } from '../lib/coerce'
import type { ServerRunRow } from '../lib/coerce'
import { isAllScopeRole } from '../lib/scope'
import type { RunsScope } from '../lib/scope'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { runsScopeChanged, runsStatusFilterChanged } from '../store/uiSlice'
import type { RunsStatusFilter } from '../store/uiSlice'
import { useListRunsQuery, useWhoamiQuery, workflowApi } from '../store/workflowApi'

/**
 * Lifecycle order, so the dropdown reads the way a run moves: a dispatched run
 * waiting to be picked up (apps#671) comes before one that is under way.
 */
const FILTERS: RunsStatusFilter[] = ['all', 'queued', 'running', 'succeeded', 'failed', 'cancelled']

const LABELS: Record<RunsStatusFilter, string> = {
  all: 'All statuses',
  queued: 'Queued',
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
      <Link to={stepPath(base, run.runId, first.key)} title={first.key}>
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
  const scope = useAppSelector((state) => state.ui.runsScope)
  // Whether to offer the toggle at all — the one thing the SPA cannot work out
  // for itself (spec 11 §Why `projectRole`). Advisory, like every affordance
  // here: the list rule re-reads the role server-side and answers 403 to an ask
  // it will not honour, so a wrong answer can only ever offer a refusal.
  const { data: me } = useWhoamiQuery()

  const { data: runs, isLoading, isError, error, refetch } = useListRunsQuery(
    impl && workflow ? { impl, workflow, ...(scope === 'all' ? { scope: 'all' as const } : {}) } : skipToken,
  )

  /**
   * Turning the toggle drops what the *old* scope cached. The list itself is
   * keyed by its arguments, so it refetches on its own — but every single run
   * this page links to was fetched under the narrower ask, and a `Run` entry
   * cached as "not found" would survive the widening and make the toggle look
   * broken on the very run it was flipped for.
   */
  const scopeChanged = useCallback(
    (next: RunsScope): void => {
      dispatch(runsScopeChanged(next))
      dispatch(workflowApi.util.invalidateTags(['Runs', 'Run']))
    },
    [dispatch],
  )

  /**
   * A stale ask narrows itself (fix round 1). The ask outlives the session
   * that made it — it is remembered per *browser* (`lib/scope.ts`), so a
   * shared machine, a signed-out admin or a role taken away all leave a
   * `'all'` behind that the person now looking at the page cannot hold. They
   * get no toggle to turn it off with (that is gated on the role), every list
   * request 403s, and the only affordance left — Retry — repeats the same 403
   * for ever. So the page puts itself right instead:
   *
   * - `whoami` has loaded and does not carry the role: narrow. This is the
   *   common case and it happens before the person sees an error at all.
   * - the list answered **403**: narrow anyway. `whoami` is cached for the
   *   life of the app, so a role taken away mid-session is a thing only the
   *   refusal itself knows about.
   *
   * Narrowing writes storage (`runsScopeChanged`), so the header stops riding
   * every other call this browser makes too — not just this list.
   */
  const staleAsk =
    scope === 'all' &&
    ((me !== undefined && !isAllScopeRole(me.projectRole)) ||
      (error as { status?: number } | undefined)?.status === 403)

  useEffect(() => {
    if (staleAsk) scopeChanged('mine')
  }, [staleAsk, scopeChanged])

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
            dispatch(runsStatusFilterChanged(event.target.value as RunsStatusFilter))
          }
        >
          {FILTERS.map((value) => (
            <option key={value} value={value}>
              {LABELS[value]}
            </option>
          ))}
        </select>
        {/*
          The exemption is asked for, never assumed (D27): a project owner or
          admin sees their own runs like anyone else until they turn this on.
          Nobody else is shown it — and a hand-set ask without the role is a
          403, not a quietly narrowed list.
        */}
        {isAllScopeRole(me?.projectRole) && (
          <label className="filter" htmlFor="runs-scope">
            <input
              id="runs-scope"
              type="checkbox"
              checked={scope === 'all'}
              onChange={(event) => scopeChanged(event.target.checked ? 'all' : 'mine')}
            />{' '}
            All runs
          </label>
        )}
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
            {shown.map((row) => {
              /*
                The one branch a queued entry costs (apps#671). `run` is null
                for a dispatched run nobody has picked up yet: there is no
                `workflow_runs` row behind it, so its duration, annotations and
                outputs are not empty — they are not known, and the table
                already renders that as an em dash. Re-run is hidden rather
                than dashed: it prefills a kickoff from a run row, and until
                that row exists the link would open an empty form.
              */
              const run = isQueuedRun(row) ? null : row
              return (
                <tr key={row.runId}>
                  <td>
                    {/* The link a queued run resolves into: until its row
                        lands it reads exactly like the not-found state an
                        unreachable run already shows. */}
                    <Link to={`${base}/runs/${row.runId}`}>{row.runId}</Link>
                  </td>
                  <td>
                    <StatusPill status={row.status} />
                    {run && <WaitingOn run={run} base={base} />}
                  </td>
                  {/* A person, not a uuid (spec 11 §What the person sees): the
                      denormalised email written at create time, falling back to
                      the id for a row written before that column existed. */}
                  <td>{row.startedByEmail ?? row.startedBy ?? '—'}</td>
                  <td>{new Date(row.startedAt).toLocaleString()}</td>
                  <td>
                    {run?.finishedAt == null ? '—' : formatDuration(run.finishedAt - run.startedAt)}
                  </td>
                  <td>{run ? <AnnotationCountsCell run={run} /> : '—'}</td>
                  <td>{run ? outputsCell(run) : '—'}</td>
                  <td>{run && <Link to={`${base}/run?from=${row.runId}`}>Re-run</Link>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}
    </section>
  )
}
