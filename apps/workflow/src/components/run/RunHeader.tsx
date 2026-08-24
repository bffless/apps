/**
 * The run page's first section (08): what ran, how it's going (or ended), and
 * the ways out of it.
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
import { formatDuration } from '../../lib/duration'
import { pluralize } from '../../lib/plural'
import type { Annotation, RunStatus } from '../../lib/runner/types'

const LEVELS: Annotation['level'][] = ['error', 'warning', 'notice']
const TICK_MS = 1_000

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
}: RunHeaderProps) {
  const inFlight = finishedAt === null
  const now = useNow(inFlight)
  const elapsedMs = inFlight ? (now === null ? null : now - startedAt) : finishedAt - startedAt

  const counts = LEVELS.map((level) => ({
    level,
    count: annotations.filter((annotation) => annotation.level === level).length,
  })).filter((entry) => entry.count > 0)

  return (
    <header className="run-head">
      <div className="run-head-title">
        <h1 className="page-title">{workflowName}</h1>
        <span data-testid="run-status" data-state={status}>
          <StatusPill status={status} />
        </span>
      </div>

      <ul className="meta run-meta">
        <li className="run-id">{runId}</li>
        {startedBy && <li>{startedBy}</li>}
        <li>{new Date(startedAt).toLocaleString()}</li>
        <li>{elapsedMs === null ? 'in flight' : formatDuration(elapsedMs)}</li>
        {progress && (
          <li>
            {progress.done} of {progress.total} done
          </li>
        )}
        {headless && <li className="badge">headless</li>}
        {counts.map(({ level, count }) => (
          <li className="badge" key={level} data-severity={level}>
            {pluralize(count, level)}
          </li>
        ))}
      </ul>

      <nav className="page-actions">
        <Link to={`${base}/file`} state={{ yaml, runId }}>
          View workflow file
        </Link>
        <Link to={`${base}/run?from=${runId}`}>Re-run</Link>
        {/* The Cancel button lands here — Task 19 wires it against `runnerControllers`. */}
        {live && <span className="page-actions-live" data-testid="run-actions-live" />}
      </nav>
    </header>
  )
}
