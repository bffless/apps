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
import { itemLabel, itemTotal, jobDuration, jobStatus, stepsOfJob } from '../../lib/runner/jobs'
import type { Definition, RunState } from '../../lib/runner/types'
import { jobPath, runPath } from '../../lib/runRoutes'
import { StatusGlyph } from '../StatusPill'
import { jobLabel } from '../graph/geometry'

export interface RunRailProps {
  base: string
  runId: string
  def: Definition | null
  state: RunState | null
  yaml?: string
}

export function RunRail({ base, runId, def, state, yaml }: RunRailProps) {
  // Rendered by the layout, so `useParams` would not see the job route's params (Global Constraints).
  const currentJob = useMatch('/:impl/:workflow/runs/:runId/job/:job/:index?')?.params.job
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const isOpen = (job: string) => opened.has(job) || currentJob === job
  const toggle = (job: string) =>
    setOpened((prev) => {
      const next = new Set(prev)
      if (next.has(job) || currentJob === job) next.delete(job)
      else next.add(job)
      return next
    })

  return (
    <nav className="rail run-rail" aria-label="Run">
      <Link className="rail-back" data-testid="rail-back" to={base}>← Workflow</Link>
      <NavLink className="rail-row rail-summary" data-testid="rail-summary" to={runPath(base, runId)} end>
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
                    <NavLink className="rail-row rail-job" data-testid="rail-job" data-job={job} to={jobPath(base, runId, job)} end>
                      <StatusGlyph status={jobStatus(states)} />
                      <span className="rail-row-name">{jobLabel(decl)}</span>
                      {duration !== undefined && <span className="rail-row-meta">{formatDuration(duration)}</span>}
                    </NavLink>
                  </li>
                )
              }
              const total = itemTotal(state, job)
              const done = Array.from({ length: total }).filter((_, i) =>
                stepsOfJob(def, state, job, i).every((r) => r.state && ['succeeded', 'failed', 'skipped', 'cancelled'].includes(r.state.status)),
              ).length
              const open = isOpen(job)
              return (
                <li key={job}>
                  <div className="rail-matrix" data-testid="rail-matrix" data-job={job}>
                    <NavLink className="rail-row rail-job" data-testid="rail-job" data-job={job} to={jobPath(base, runId, job)} end>
                      <StatusGlyph status={jobStatus(states)} />
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
                        const itemStates = stepsOfJob(def, state, job, i).flatMap((r) => (r.state ? [r.state] : []))
                        return (
                          <li key={i}>
                            <NavLink className="rail-row rail-job rail-item" data-testid="rail-job" data-job={job} data-index={i} to={jobPath(base, runId, job, i)} end>
                              <StatusGlyph status={jobStatus(itemStates)} />
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
        <li><Link className="rail-row" to={`${base}/runs`}>Past runs</Link></li>
        <li><Link className="rail-row" to={`${base}/file`} state={{ yaml, runId }}>Workflow file</Link></li>
      </ul>
    </nav>
  )
}
