/**
 * The job page's head (spec 2026-09-08, phase 3): who this page is about, and
 * the two actions that belong to the job rather than to any one step.
 *
 * The workflow page renders the same head in `definition` mode — the same job,
 * before any run of it exists — where every line that reads an *attempt* is
 * simply absent (see `mode` below).
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
 * rendered without a page above it (a test, the workflow page's definition
 * head) must not offer a move nothing can honour.
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
  /** The folded run — `run` mode only; a definition head has no run to read. */
  state?: RunState
  job: string
  /**
   * `run` is a job of a run (the status pill, the duration, the item, the
   * crumb up to the Summary); `definition` is the same job before any run
   * exists — the workflow page's head. Everything a definition cannot know is
   * simply absent there rather than guessed: no pill (there is no attempt to
   * report), no duration, no `Run ›` crumb (there is no run above it), and a
   * matrix job is `matrix` without a count, because how many items it fans out
   * into is a fact only a run has.
   */
  mode?: 'run' | 'definition'
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

export function JobHead({ def, state, job, index, mode = 'run', onFork, onRun, source }: JobHeadProps) {
  const decl = def.jobs[job]
  const label = decl ? jobLabel(decl) : job
  // Every line below the name is a fact about an *attempt*, so a definition
  // head reads none of them — there is no state to read them from.
  const run = mode === 'run' && state !== undefined
  const rows = run ? stepsOfJob(def, state, job, index) : []
  const states = rows.flatMap((row) => (row.state ? [row.state] : []))
  const duration = run ? jobDuration(states) : undefined
  const total = run ? itemTotal(state, job) : 1
  const note = decl ? matrixNote(decl) : null
  // Only a job that actually fanned out has *items*: an `/0` on a plain job's
  // URL is the one and only leg of it, and calling that "item 1 of 1" would
  // invent a level the workflow never declared.
  const isItem = run && index !== undefined && decl?.matrix !== undefined
  const item = isItem ? (state.expansions[job]?.items[index!] ?? {}) : undefined
  const kind = isItem
    ? 'item'
    : decl?.matrix
      ? run
        ? `matrix · ${total} ${total === 1 ? 'item' : 'items'}`
        : 'matrix'
      : 'job'

  return (
    <header className="job-head" data-testid="job-head">
      <span className="job-head-title">
        {run && (
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
        )}
        <h2 className="job-head-name">{label}</h2>
        <span className="pane-key">{job}</span>
      </span>

      {/*
        `isItem ? index : undefined` — a plain job's `/0` route is the job, not
        "item 0" of it, so its pill must read the *engine's* result (which
        absorbs a `continue-on-error` failure and a headless skip) rather than a
        per-item fold over the same rows. Passing `index` here unconditionally
        made `/job/confirm/0` print Skipped on a headless run while the rail,
        the node and `/job/confirm` all printed Succeeded.
      */}
      {run && <StatusPill status={jobStatus(def, state, job, isItem ? index : undefined)} />}
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
