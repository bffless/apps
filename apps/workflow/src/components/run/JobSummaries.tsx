/**
 * The Summary's per-job summaries (08 §4, spec 2026-09-08 Task 9), the
 * harness's answer to GitHub's job summaries: every step's `summary`,
 * grouped by the job (and matrix item) that wrote it, in scheduling order —
 * topological job order, then matrix item, then declaration order — each
 * heading a way into that job's own page, each body the markdown it is (05:
 * HTML is never interpreted).
 */
import { Link } from 'react-router-dom'
import { itemLabel, jobLabel } from '../graph/geometry'
import { jobOrder } from '../../lib/runner/graph'
import { itemTotal, stepsOfJob } from '../../lib/runner/jobs'
import type { Definition, RunState } from '../../lib/runner/types'
import { jobPath } from '../../lib/runRoutes'
import { MarkdownView } from '../values/MarkdownView'

export interface JobSummariesProps {
  def: Definition
  state: RunState
  base: string
  runId: string
}

interface Entry {
  job: string
  index: number
  label: string
  href: string
  summaries: string[]
}

function summaryEntries(def: Definition, state: RunState, base: string, runId: string): Entry[] {
  const entries: Entry[] = []
  for (const job of jobOrder(def)) {
    const decl = def.jobs[job]
    if (!decl) continue
    const matrix = Boolean(decl.matrix)
    const total = itemTotal(state, job)
    for (let index = 0; index < total; index += 1) {
      const summaries = stepsOfJob(def, state, job, index)
        .map((row) => row.state?.summary)
        .filter((summary): summary is string => Boolean(summary))
      if (summaries.length === 0) continue
      const label = matrix
        ? `${jobLabel(decl)} (${itemLabel(state.expansions[job]?.items[index] ?? {}, index)})`
        : jobLabel(decl)
      entries.push({
        job,
        index,
        label,
        href: matrix ? jobPath(base, runId, job, index) : jobPath(base, runId, job),
        summaries,
      })
    }
  }
  return entries
}

export function JobSummaries({ def, state, base, runId }: JobSummariesProps) {
  const entries = summaryEntries(def, state, base, runId)

  return (
    <section className="run-summary" data-testid="run-summary">
      <h4 className="section-title">Summary</h4>
      {entries.length === 0 ? (
        <p className="note">No step wrote a summary.</p>
      ) : (
        <div className="summary-entries">
          {entries.map((entry) => (
            <article
              className="summary-entry"
              data-job={entry.job}
              data-index={entry.index}
              key={`${entry.job}-${entry.index}`}
            >
              <h4>
                <Link to={entry.href}>{entry.label} summary</Link>
              </h4>
              {entry.summaries.map((summary, i) => (
                <MarkdownView key={i} value={summary} />
              ))}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
