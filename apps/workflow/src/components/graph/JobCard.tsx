/**
 * One job of the graph, as one node (spec 2026-09-08, Task 8).
 *
 * The graph draws **jobs**, never steps: a job's steps are the job page's list
 * now, so a node says what a person choosing between jobs needs — the job's
 * name, what it fans out over, and one status line. In run mode that line is
 * the folded status (`jobStatus`), how long the job took (`jobDuration`), and
 * for a matrix job how many of its items are done; in definition mode it is
 * the step count and the outputs the job promises, with their types.
 *
 * A matrix job is one node, not N, and it carries no item selector: items live
 * in the run rail. That keeps the layout a function of the *definition* — the
 * graph never grows or reflows as a run fans out — and every node's height
 * comes from `cardHeight`, so `GraphView` can draw connectors and edge dots
 * without a layout pass.
 *
 * The whole node is one `<button>`: the job is the middle level of run › job ›
 * step, so it is one keyboard-reachable target with one selected state
 * (`aria-pressed`), and clicking it reports the job id to its owner. Its
 * *content* is its accessible name — an `aria-label` here would override that
 * with the job's name alone and hide everything the node exists to say: the
 * status word, the duration, `N of M done`, the matrix note, the OUT rows.
 */
import type { CSSProperties } from 'react'
import { formatDuration } from '../../lib/duration'
import { pluralize } from '../../lib/plural'
import { jobDuration, jobStatus, itemTotal, stepsOfJob } from '../../lib/runner/jobs'
import type { Definition, Job, RunState, StepStatus } from '../../lib/runner/types'
import { StatusGlyph } from '../StatusPill'
import { STATUS_LABEL } from '../statusLabels'
import type { GraphFlow } from './flow'
import { declaredJobOutputs, jobLabel, matrixNote } from './geometry'

const TERMINAL: ReadonlySet<StepStatus> = new Set<StepStatus>([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
])

export interface JobCardProps {
  job: Job
  def: Definition
  /** Layout position: topological layer, and the slot within it. */
  col: number
  row: number
  mode: 'definition' | 'run'
  state?: RunState
  selected?: boolean
  /** `side` is set when the click came from an edge dot (08: "jump straight to one side"). */
  onPick: (job: string, side?: 'Input' | 'Output') => void
  /** Which nodes light up for the hovered value (08); absent outside `GraphView`'s own render. */
  flow?: GraphFlow
  style?: CSSProperties
}

export function JobCard({ job, def, col, row, mode, state, selected, onPick, flow, style }: JobCardProps) {
  const rows = state ? stepsOfJob(def, state, job.id) : []
  const states = rows.flatMap((r) => (r.state ? [r.state] : []))
  const status = jobStatus(states)
  const duration = jobDuration(states)
  const isMatrix = job.matrix !== undefined
  const total = state ? itemTotal(state, job.id) : 1
  const done = state
    ? Array.from({ length: total }).filter((_, i) =>
        stepsOfJob(def, state, job.id, i).every((r) => r.state && TERMINAL.has(r.state.status)),
      ).length
    : 0
  const jobFlow = flow?.sourceJobs.has(job.id)
    ? 'source'
    : flow?.targetJobs.has(job.id)
      ? 'target'
      : undefined
  const note = matrixNote(job)
  const outs = mode === 'definition' ? declaredJobOutputs(def, job.id) : []

  return (
    <button
      type="button"
      className="job-card"
      data-testid="job"
      data-job={job.id}
      data-col={col}
      data-row={row}
      data-flow={jobFlow}
      data-state={mode === 'run' ? status : 'declared'}
      aria-pressed={selected ?? false}
      style={style}
      onClick={() => onPick(job.id)}
    >
      <span className="job-head">
        {isMatrix && <span className="job-eyebrow">Matrix · {job.id}</span>}
        <span className="job-name">{jobLabel(job)}</span>
      </span>
      {note && <span className="job-note">{note}</span>}
      <span className="job-status">
        {mode === 'run' ? (
          <>
            <StatusGlyph status={status} />
            <span className="job-status-word">
              {isMatrix && state ? `${done} of ${total} done` : STATUS_LABEL[status]}
            </span>
            {duration !== undefined && <span className="job-meta">{formatDuration(duration)}</span>}
          </>
        ) : (
          <span className="job-status-word">{pluralize(job.steps.length, 'step')}</span>
        )}
      </span>
      {outs.length > 0 && (
        <span className="job-outs">
          {outs.map(([name, type]) => (
            <span className="step-output" key={name}>
              <span className="out-tag" aria-hidden="true">
                out
              </span>
              <span className="out-name">{name}</span>
              <span className="out-type">{type}</span>
            </span>
          ))}
        </span>
      )}
    </button>
  )
}
