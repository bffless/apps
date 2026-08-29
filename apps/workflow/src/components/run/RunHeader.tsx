/**
 * The run page's first section (08): what ran, how it's going (or ended), and
 * the ways out of it — a title row with the actions, then the prototype's
 * one-line **run bar** (status glyph, progress, elapsed, the badges).
 *
 * "View workflow file" carries the run's **own** YAML in the navigation state
 * (D16) rather than linking at the file the implementation publishes now — a
 * run is a record, and what it did is what its snapshot says.
 *
 * Plain display fields, not a `ServerRunRow`: the live path (Phase 3) has no
 * server row to read — only the slice's `RunState` + `RunMeta` — so this
 * component takes exactly what it shows, and the run page decides where each
 * field comes from (the row, for a replayed run; the slice, for a live one).
 *
 * The elapsed time on an unfinished run **ticks** (Task 18) — `Date.now()`
 * belongs to an effect, never to render (react-hooks/purity), so `useNow`
 * below is the only place this component ever reads the clock.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { StatusPill } from '../StatusPill'
import { ANNOTATION_LEVELS } from '../../lib/annotations'
import { formatDuration } from '../../lib/duration'
import { pluralize } from '../../lib/plural'
import type { Annotation, RunStatus } from '../../lib/runner/types'

const TICK_MS = 1_000

/** Deletion takes the run's files with it (05) — the one header action that asks first. */
const DELETE_CONFIRM = 'Delete this run and its files? This cannot be undone.'

/**
 * `Date.now()`, refreshed every `intervalMs` while `active` — never read at
 * render time (react-hooks/purity), and never set synchronously inside the
 * effect body either (react-hooks/set-state-in-effect): the first tick is
 * scheduled through a microtask, same as every tick after it, rather than
 * called directly while the effect itself is still running.
 */
function useNow(active: boolean, intervalMs = TICK_MS): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    const id = setInterval(tick, intervalMs)
    queueMicrotask(tick)
    return () => clearInterval(id)
  }, [active, intervalMs])
  return now
}

export interface RunHeaderProps {
  workflowName: string
  runId: string
  /** The session user that started the run (01); absent for an older/unknown row. */
  startedBy?: string
  startedAt: number
  /** `null` while the run is still in flight. */
  finishedAt: number | null
  headless: boolean
  /** The run's own snapshot, for "View workflow file". */
  yaml: string
  /** The replayed status; the row's own when the run could not be rebuilt. */
  status: RunStatus
  /** Every annotation of the run, run-level and per step. */
  annotations: Annotation[]
  /** `/<impl>/<workflow>` — the run's screens hang off it. */
  base: string
  /** Terminal steps against every step the run currently knows about (08). */
  progress?: { done: number; total: number }
  /** This tab is the one driving the run — the Cancel slot only applies here (Task 19). */
  live?: boolean
  /** Present, and rendered as the Cancel button, only while there is a running live run to cancel. */
  onCancel?: () => void
  /**
   * Present, and rendered as the Delete button, only when the page has decided
   * this run may be deleted (terminal, and owned by this user or an admin —
   * `RunPage.tsx`). Unlike Cancel this is **not** a live-only action: a record
   * is deletable long after the tab that drove it is gone.
   */
  onDelete?: () => void
  /** A delete is in flight; the button stays visible but refuses a second press. */
  deleting?: boolean
}

export function RunHeader({
  workflowName,
  runId,
  startedBy,
  startedAt,
  finishedAt,
  headless,
  yaml,
  status,
  annotations,
  base,
  progress,
  live = false,
  onCancel,
  onDelete,
  deleting = false,
}: RunHeaderProps) {
  const inFlight = finishedAt === null
  const now = useNow(inFlight)
  const elapsedMs = inFlight ? (now === null ? null : now - startedAt) : finishedAt - startedAt

  const counts = ANNOTATION_LEVELS.map((level) => ({
    level,
    count: annotations.filter((annotation) => annotation.level === level).length,
  })).filter((entry) => entry.count > 0)

  return (
    <header className="run-head">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">{workflowName}</h1>
          <p className="page-sub run-sub">
            <span className="run-id">{runId}</span>
            {startedBy && (
              <>
                <span className="sep">·</span>
                <span>{startedBy}</span>
              </>
            )}
            <span className="sep">·</span>
            <span>{new Date(startedAt).toLocaleString()}</span>
          </p>
        </div>

        <nav className="page-actions">
          <Link className="button" to={`${base}/runs`}>
            Past runs
          </Link>
          <Link className="button" to={`${base}/file`} state={{ yaml, runId }}>
            View workflow file
          </Link>
          {live && (
            <span className="page-actions-live" data-testid="run-actions-live">
              {onCancel && (
                <button type="button" className="button" data-testid="run-cancel" onClick={onCancel}>
                  Cancel
                </button>
              )}
            </span>
          )}
          {/*
            Deletion takes the run's files with it and cannot be undone (05), so
            it is confirmed here rather than in the page: whoever renders this
            header gets the confirm for free, and there is no way to wire the
            button up without one.
          */}
          {onDelete && (
            <button
              type="button"
              className="button danger"
              data-testid="run-delete"
              disabled={deleting}
              onClick={() => {
                if (window.confirm(DELETE_CONFIRM)) onDelete()
              }}
            >
              Delete
            </button>
          )}
          <Link className="button primary" to={`${base}/run?from=${runId}`}>
            Re-run
          </Link>
        </nav>
      </div>

      <div className="run-bar">
        <span className="run-bar-status" data-testid="run-status" data-state={status}>
          <StatusPill status={status} />
        </span>
        <span className="run-bar-meta">
          {progress && (
            <span>
              {progress.done} of {progress.total} done
            </span>
          )}
          <span>{elapsedMs === null ? 'in flight' : formatDuration(elapsedMs)}</span>
          {inFlight && elapsedMs !== null && <span>elapsed</span>}
        </span>
        <span className="run-bar-badges">
          {headless && <span className="badge">headless</span>}
          {counts.map(({ level, count }) => (
            <span className="badge" key={level} data-severity={level}>
              {pluralize(count, level)}
            </span>
          ))}
        </span>
      </div>
    </header>
  )
}
