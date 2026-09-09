/**
 * The job page's head (spec 2026-09-08, phase 3): who this page is about, and
 * the two actions that belong to the job rather than to any one step.
 *
 * Lifted out of the old `JobPane`'s `<header>` — the eyebrow crumb, the label,
 * the job key, the status pill, the matrix note and the fork button all read
 * the same as they did — with two changes the GitHub shape asks for: the
 * **Input | Output** toggle moved down into `JobIo`'s disclosure (the head is
 * not a tabbed card any more), and the duration is printed beside the pill,
 * because the head is now the only place the job's own timing is stated.
 *
 * The eyebrow is also the way *up*: the step's own crumb went with the pane,
 * so `Run` here is the one climb out of a job (the rail's Summary row being
 * the other). It is only a button when the page hands it a `onRun` — the same
 * contract the fork button has always had, and for the same reason: a head
 * rendered without a page above it (a test, PR 5's definition view) must not
 * offer a move nothing can honour.
 */
import { formatDuration } from '../../lib/duration'
import { jobDuration, jobStatus, itemTotal, stepsOfJob } from '../../lib/runner/jobs'
import type { Definition, RunState } from '../../lib/runner/types'
import { StatusPill } from '../StatusPill'
import { itemLabel, jobLabel, matrixNote } from '../graph/geometry'
import { YamlControl } from './YamlDrawer'
import type { YamlSource } from './YamlDrawer'

export interface JobHeadProps {
  def: Definition
  state: RunState
  job: string
  /** One item of a matrix job; absent on the collect view and on a plain job. */
  index?: number
  /**
   * Present, and rendered as "Re-run from this job", only when the page has
   * decided this job can be forked from (a terminal replayed run, every job
   * outside `job`'s downstream closure `success`/`skipped`, the current
   * workflow loaded — `RunShell`'s `forkable`). The fork itself is the page's.
   */
  onFork?: () => void
  /** Up one level, to the run's Summary — the eyebrow's `Run`. */
  onRun?: () => void
  /** The run's YAML snapshot, for the **YAML** drawer (apps#449); absent when there is no run source to show. */
  source?: YamlSource
}

export function JobHead({ def, state, job, index, onFork, onRun, source }: JobHeadProps) {
  const decl = def.jobs[job]
  const label = decl ? jobLabel(decl) : job
  const rows = stepsOfJob(def, state, job, index)
  const states = rows.flatMap((row) => (row.state ? [row.state] : []))
  const duration = jobDuration(states)
  const total = itemTotal(state, job)
  const note = decl ? matrixNote(decl) : null
  // Only a job that actually fanned out has *items*: an `/0` on a plain job's
  // URL is the one and only leg of it, and calling that "item 1 of 1" would
  // invent a level the workflow never declared.
  const isItem = index !== undefined && decl?.matrix !== undefined
  const item = isItem ? (state.expansions[job]?.items[index!] ?? {}) : undefined
  const kind = isItem
    ? 'item'
    : decl?.matrix
      ? `matrix · ${total} ${total === 1 ? 'item' : 'items'}`
      : 'job'

  return (
    <header className="job-head" data-testid="job-head">
      <span className="job-head-title">
        <nav className="job-eyebrow" aria-label="Where this sits">
          {onRun ? (
            <button type="button" className="pane-crumb" onClick={onRun}>
              Run
            </button>
          ) : (
            <span className="pane-crumb is-static">Run</span>
          )}
          <span className="pane-crumb-sep" aria-hidden="true">
            ›
          </span>
          <span className="pane-crumb is-current" aria-current="location">
            Job
          </span>
          {isItem && (
            <>
              <span className="pane-crumb-sep" aria-hidden="true">
                ›
              </span>
              <span className="pane-crumb is-current">Item</span>
            </>
          )}
        </nav>
        <h2 className="job-head-name">{label}</h2>
        <span className="pane-key">{job}</span>
      </span>

      <StatusPill status={jobStatus(states)} />
      {duration !== undefined && <span className="job-head-meta">{formatDuration(duration)}</span>}
      {note && <span className="job-head-note">{note}</span>}
      {isItem && (
        <span className="job-head-item">
          item {index! + 1} of {total}
          {item && Object.keys(item).length > 0 ? ` · ${itemLabel(item, index!)}` : ''}
        </span>
      )}

      <span className="job-head-actions">
        {/* A new run from this job on, the jobs before it copied from this one (05; apps#491). */}
        {onFork && (
          <button type="button" className="button" data-testid="job-fork" onClick={onFork}>
            Re-run from this job
          </button>
        )}
        {/* The job's whole block in the run's own snapshot, in place (apps#449). */}
        {source && <YamlControl source={source} subject={job} target={{ job }} />}
      </span>

      <span className="pane-kind">{kind}</span>
    </header>
  )
}
