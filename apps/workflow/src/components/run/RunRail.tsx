/**
 * The run's rail (spec 2026-09-08 §The run rail): in place of the
 * implementation tree while inside a run — a way back to the workflow,
 * Summary, one row per job (a matrix job a group of its items), then the run
 * details. Every row is a NavLink, so a click is a person's navigation.
 */
import { useState } from 'react'
import { Link, NavLink, useMatch } from 'react-router-dom'
import { formatDuration } from '../../lib/duration'
import { jobOrder } from '../../lib/runner/graph'
import { itemTotal, itemsDone, jobDuration, jobStatus, stepsOfJob } from '../../lib/runner/jobs'
import type { Definition, RunState } from '../../lib/runner/types'
import { jobPath, runPath } from '../../lib/runRoutes'
import { StatusGlyph } from '../StatusPill'
import { itemLabel, jobLabel } from '../graph/geometry'

export interface RunRailProps {
  base: string
  runId: string
  def: Definition | null
  state: RunState | null
  yaml?: string
  /** A person's navigation, on every row (Summary, jobs, items, Past runs, Workflow file) — never the chevron, which only opens or closes a group. */
  onNavigate?: () => void
}

export function RunRail({ base, runId, def, state, yaml, onNavigate }: RunRailProps) {
  // Rendered by the layout, so `useParams` would not see the job route's params (Global Constraints).
  const currentJob = useMatch('/:impl/:workflow/runs/:runId/job/:job/:index?')?.params.job
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  // A job the route currently names is open by default (`currentJob === job`),
  // but that default must still yield to an explicit close — otherwise the
  // group on the job you're on can never collapse (fix round 5, finding 4):
  // `toggle` on it always saw itself as "not open" (`opened` never held it)
  // and could only ever add it, a no-op against the route's own default.
  // `closed` is the one place a person's own close is remembered, checked
  // after both of the reasons a group would default to open.
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const isOpen = (job: string) => (opened.has(job) || currentJob === job) && !closed.has(job)
  const toggle = (job: string) => {
    if (isOpen(job)) {
      setClosed((prev) => new Set(prev).add(job))
      return
    }
    setClosed((prev) => {
      if (!prev.has(job)) return prev
      const next = new Set(prev)
      next.delete(job)
      return next
    })
    setOpened((prev) => new Set(prev).add(job))
  }

  return (
    <nav className="rail run-rail" aria-label="Run">
      <Link className="rail-back" data-testid="rail-back" to={base} onClick={onNavigate}>← Workflow</Link>
      <NavLink className="rail-row rail-summary" data-testid="rail-summary" to={runPath(base, runId)} end onClick={onNavigate}>
        {state && <StatusGlyph status={state.status} />}
        <span className="rail-row-name">Summary</span>
      </NavLink>

      {def && state && (
        <>
          <p className="rail-eyebrow">Jobs</p>
          <ul className="rail-jobs">
            {jobOrder(def).map((job) => {
              const decl = def.jobs[job]!
              const rows = stepsOfJob(def, state, job)
              const states = rows.flatMap((r) => (r.state ? [r.state] : []))
              const duration = jobDuration(states)
              if (decl.matrix === undefined) {
                return (
                  <li key={job}>
                    <NavLink className="rail-row rail-job" data-testid="rail-job" data-job={job} to={jobPath(base, runId, job)} end onClick={onNavigate}>
                      <StatusGlyph status={jobStatus(def, state, job)} />
                      <span className="rail-row-name">{jobLabel(decl)}</span>
                      {duration !== undefined && <span className="rail-row-meta">{formatDuration(duration)}</span>}
                    </NavLink>
                  </li>
                )
              }
              const total = itemTotal(state, job)
              const done = itemsDone(def, state, job)
              const open = isOpen(job)
              return (
                <li key={job}>
                  <div className="rail-matrix" data-testid="rail-matrix" data-job={job}>
                    <NavLink className="rail-row rail-job" data-testid="rail-job" data-job={job} to={jobPath(base, runId, job)} end onClick={onNavigate}>
                      <StatusGlyph status={jobStatus(def, state, job)} />
                      <span className="rail-row-name">{jobLabel(decl)}</span>
                      <span className="rail-row-meta">{done} of {total}</span>
                    </NavLink>
                    <button type="button" className="rail-chevron" aria-expanded={open} aria-label={open ? 'Hide items' : 'Show items'} onClick={() => toggle(job)}>
                      {open ? '▾' : '▸'}
                    </button>
                  </div>
                  {open && (
                    <ul className="rail-items">
                      {Array.from({ length: total }, (_, i) => {
                        const item = state.expansions[job]?.items[i] ?? {}
                        return (
                          <li key={i}>
                            <NavLink className="rail-row rail-job rail-item" data-testid="rail-job" data-job={job} data-index={i} to={jobPath(base, runId, job, i)} end onClick={onNavigate}>
                              <StatusGlyph status={jobStatus(def, state, job, i)} />
                              <span className="rail-row-name">{itemLabel(item, i)}</span>
                            </NavLink>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      <p className="rail-eyebrow">Run details</p>
      <ul className="rail-details">
        <li><Link className="rail-row" to={`${base}/runs`} onClick={onNavigate}>Past runs</Link></li>
        <li><Link className="rail-row" to={`${base}/file`} state={{ yaml, runId }} onClick={onNavigate}>Workflow file</Link></li>
      </ul>
    </nav>
  )
}
