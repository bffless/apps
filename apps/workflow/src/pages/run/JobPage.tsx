/**
 * One job of a run (spec 2026-09-08), at `/job/:job` — `/job/:job/:index` for
 * one item of a matrix — as GitHub's job page: a head saying which job this
 * is, the job's own inputs and outputs folded into a collapsed disclosure, and
 * the steps as rows that **expand in place**. There is no step *route* any
 * more and no step card: `?step=<key>` names which row is open, so a step is
 * still linkable and the browser's Back button still climbs out of one, but
 * the page around it never goes away.
 *
 * Three variants, and which one renders is a reading of the URL against the
 * definition, never a piece of state:
 *
 * - **plain / item** — the steps of one leg (`stepsOfJob(def, state, job,
 *   index ?? 0)`), each a row.
 * - **matrix collect** (a matrix job with no `:index`) — the job as a whole:
 *   its *collected* outputs, and one link per item. Deliberately no step
 *   rows: 2 items × 3 steps is a list whose rows say nothing about which leg
 *   they belong to, and the item links are the answer to that question.
 * - **error** — a `?step=` naming another job belongs on that job's page, an
 *   `:index` past the fan-out belongs on the collect view, and a job the
 *   workflow does not declare gets the head and a note.
 *
 * Which rows are open is `useState`, seeded from `?step=` and *added to* by it
 * — never trimmed by it. Following writes `?step=` as the run moves; if that
 * closed the row it left, a person reading a finished step would have it
 * yanked shut under them, and a form they were half-way through filling in
 * would lose its draft. Only the person's own toggle closes a row (Decision 7:
 * any number may be open at once).
 */
import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { JobHead } from '../../components/run/JobHead'
import { JobIo } from '../../components/run/JobIo'
import { StepRow } from '../../components/run/StepRow'
import { stepRowId } from '../../components/run/stepRowId'
import { StatusGlyph } from '../../components/StatusPill'
import { flowFor } from '../../components/graph/flow'
import { itemLabel } from '../../components/graph/geometry'
import { formatDuration } from '../../lib/duration'
import { isTerminal, itemTotal, jobDuration, jobStatus, stepsOfJob } from '../../lib/runner/jobs'
import type { StepKey } from '../../lib/runner/types'
import { parseStepKey } from '../../lib/runner/types'
import { STEP_PARAM, TAB_PARAM, jobPath, pathForSelection } from '../../lib/runRoutes'
import { useAppSelector } from '../../store/hooks'
import { useRunContext } from './runContext'

export function JobPage() {
  const ctx = useRunContext()
  const { job = '', index: indexParam } = useParams()
  const [search] = useSearchParams()
  const rawStep = search.get(STEP_PARAM)
  const parts = rawStep ? parseStepKey(rawStep) : null
  // A bare `?step=<job>` is a job selection, not a step: it names no row.
  const step: StepKey | null = parts ? rawStep : null
  const tabParam = search.get(TAB_PARAM)
  const tab = tabParam === 'Output' ? 'Output' : tabParam === 'Input' ? 'Input' : undefined
  const parsedIndex = indexParam === undefined ? undefined : Number(indexParam)
  const index =
    parsedIndex !== undefined && Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : undefined

  const hovered = useAppSelector((s) => s.ui.hoveredValue)
  const flow = useMemo(() => flowFor(ctx.def, hovered), [ctx.def, hovered])

  // Seeded from `?step=` so a deep link arrives with its row already open.
  const [open, setOpen] = useState<Set<StepKey>>(() => new Set(step ? [step] : []))
  useEffect(() => {
    if (step === null) return
    // `setState` may not be called synchronously in an effect body
    // (react-hooks 7); the row it opens is the one the URL already names, so a
    // microtask later is still the same commit as far as the person can tell.
    queueMicrotask(() => {
      setOpen((was) => (was.has(step) ? was : new Set(was).add(step)))
    })
    // Following can move `?step=` to a row far down a long job: bring it into
    // view rather than leaving the page where the last step was.
    const row = document.getElementById(stepRowId(step))
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [step])

  const toggle = (key: StepKey) => {
    const wasOpen = open.has(key)
    setOpen((was) => {
      const next = new Set(was)
      if (wasOpen) next.delete(key)
      else next.add(key)
      return next
    })
    // The URL follows the *last* row the person touched: opening one names it,
    // closing the named one leaves the job with no step named. Closing any
    // other row is a local move — `?step=` still names a row that is open.
    if (!wasOpen) ctx.select({ kind: 'step', key })
    else if (key === step) ctx.select({ kind: 'job', job, index })
  }

  // A `?step=` of another job belongs on that job's page (spec §Error states),
  // carrying every other query parameter with it (`?mocks=`, `?tab=`).
  if (parts && parts.job !== job) {
    return (
      <Navigate
        replace
        to={pathForSelection(ctx.base, ctx.runId, { kind: 'step', key: rawStep! }, new URLSearchParams(search))}
      />
    )
  }

  const decl = ctx.def.jobs[job]
  const total = itemTotal(ctx.state, job)
  const onFork = ctx.forkable(job) ? () => void ctx.fork(job) : undefined

  if (!decl) {
    return (
      <section className="job-page" data-testid="job-page" data-job={job}>
        <JobHead def={ctx.def} state={ctx.state} job={job} onRun={ctx.toRun} />
        <p className="note">This workflow declares no such job.</p>
      </section>
    )
  }

  // An item past the fan-out is the job itself, not a 404 (spec §Error states).
  if (index !== undefined && index >= total) {
    return <Navigate replace to={jobPath(ctx.base, ctx.runId, job)} />
  }

  const collect = decl.matrix !== undefined && index === undefined

  return (
    <section className="job-page" data-testid="job-page" data-job={job}>
      <JobHead
        def={ctx.def}
        state={ctx.state}
        job={job}
        index={index}
        onFork={onFork}
        onRun={ctx.toRun}
        source={ctx.yamlSource}
      />

      <JobIo
        key={`${job}#${index ?? ''}#${tab ?? ''}`}
        def={ctx.def}
        state={ctx.state}
        job={job}
        index={index}
        impl={ctx.impl}
        initialTab={tab}
        open={tab !== undefined}
      />

      {collect ? (
        <ul className="item-list" data-testid="job-items">
          {Array.from({ length: total }, (_, i) => {
            const rows = stepsOfJob(ctx.def, ctx.state, job, i)
            const states = rows.flatMap((row) => (row.state ? [row.state] : []))
            const done = states.filter((s) => isTerminal(s.status)).length
            const duration = jobDuration(states)
            return (
              <li className="item-row" key={i}>
                <Link
                  className="item-row-link"
                  data-testid="job-item"
                  data-index={i}
                  to={jobPath(ctx.base, ctx.runId, job, i)}
                >
                  <StatusGlyph status={jobStatus(states)} />
                  <span className="step-label">
                    <span className="step-title">
                      {itemLabel(ctx.state.expansions[job]?.items[i] ?? {}, i)}
                    </span>
                  </span>
                  <span className="badge">item {i + 1}</span>
                  <span className="step-meta">
                    {duration !== undefined ? formatDuration(duration) : `${done} of ${rows.length} done`}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      ) : (
        <ul className="step-list" data-testid="job-steps">
          {stepsOfJob(ctx.def, ctx.state, job, index ?? 0).map((row) => (
            <StepRow
              key={row.key}
              def={ctx.def}
              state={ctx.state}
              row={row}
              open={open.has(row.key)}
              onToggle={toggle}
              live={ctx.isLive}
              impl={ctx.impl}
              source={ctx.yamlSource}
              initialTab={tab}
              flow={flow}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
