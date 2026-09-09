/**
 * One workflow, before it runs (08): the definition graph, the way into a run,
 * and the runs already behind it.
 *
 * A workflow that does not validate still gets a screen — it lists what the
 * linter said and offers no Start, because "the workflow appears with the lint
 * error and no Start" is the only honest thing to show: a definition the engine
 * cannot load is one it must not be asked to run.
 *
 * Clicking a job on the graph lists that job's **declared steps** under it
 * (spec 2026-09-08, §The workflow page): the same head and the same expanding
 * rows the run's job page draws, reading the workflow file instead of a run.
 * The per-step side panel the graph used to open went with them — a step's
 * declaration belongs in the step's own row, not beside the diagram.
 */
import { useMemo, useState } from 'react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { Link, useParams } from 'react-router-dom'
import { DiscoveryError } from '../components/DiscoveryError'
import { EmptyState } from '../components/EmptyState'
import { StatusPill } from '../components/StatusPill'
import { GraphView } from '../components/graph/GraphView'
import { JobHead } from '../components/run/JobHead'
import { StepRow } from '../components/run/StepRow'
import { workflowId } from '../lib/coerce'
import { loadWorkflow } from '../lib/runner/definition'
import { declaredStepsOfJob } from '../lib/runner/jobs'
import type { Definition, StepKey } from '../lib/runner/types'
import { useWorkflowListing } from '../store/useWorkflowListing'
import { useGetWorkflowYamlQuery, useListRunsQuery } from '../store/workflowApi'

/** The most recent runs shown inline; the rest live on Past runs. */
const RECENT = 5

/**
 * A job's declared steps, under the graph — the workflow page's own run › job
 * › step (spec §The workflow page). The same head and the same rows the run's
 * job page uses, in their declared reading: what the job *is*, before any run
 * of it exists.
 *
 * `open` is local and nothing else: there is no `?step=` here (no run to
 * address, so no selection worth putting in a URL), and the page is keyed on
 * the job, so choosing another job starts it fresh rather than carrying one
 * job's open row onto another. Esc is the row body's own — this page has no
 * level above the graph to climb to.
 */
function DeclaredJob({ def, job }: { def: Definition; job: string }) {
  const [open, setOpen] = useState<Set<StepKey>>(new Set())
  const toggle = (key: StepKey) =>
    setOpen((was) => {
      const next = new Set(was)
      if (!next.delete(key)) next.add(key)
      return next
    })

  return (
    <section className="job-page" data-testid="job-page" data-job={job}>
      <JobHead def={def} job={job} mode="definition" />
      <ul className="step-list" data-testid="job-steps">
        {declaredStepsOfJob(def, job).map((row) => (
          <StepRow
            key={row.key}
            def={def}
            row={row}
            mode="declared"
            open={open.has(row.key)}
            onToggle={toggle}
          />
        ))}
      </ul>
    </section>
  )
}

export function WorkflowPage() {
  const { impl: alias } = useParams()
  // The graph's click, and the whole of this page's selection state: a
  // workflow has no run to address, so nothing here belongs in the URL.
  const [selectedJob, setSelectedJob] = useState<string | null>(null)
  const { impl, listing, isLoading, isError, error } = useWorkflowListing()

  const target = impl && listing ? { impl: impl.alias, file: listing.file } : skipToken
  const { data: yaml, isError: yamlFailed } = useGetWorkflowYamlQuery(target)

  const { data: runs } = useListRunsQuery(
    impl && listing ? { impl: impl.alias, workflow: workflowId(listing.file) } : skipToken,
  )

  const loaded = useMemo(
    () => (yaml !== undefined && listing ? loadWorkflow(yaml, listing.file) : null),
    [yaml, listing],
  )

  if (isLoading) return <p className="note">Loading…</p>
  if (isError) return <DiscoveryError error={error} />
  if (!listing) {
    return (
      <EmptyState title="No such workflow">
        <p>
          This implementation published no workflow by that name.{' '}
          {/* Absolute: `Shell` is a pathless layout route, so a relative `..`
              resolves against it and lands on `/`, not on the implementation. */}
          <Link to={`/${alias}`}>Back to its workflows</Link>
        </p>
      </EmptyState>
    )
  }

  const links = (
    <nav className="page-actions">
      <Link className="button" to="runs">
        Past runs
      </Link>
      <Link className="button" to="file">
        View workflow file
      </Link>
      {loaded?.ok && (
        <Link className="button primary" to="run">
          Start a run
        </Link>
      )}
    </nav>
  )

  return (
    <section className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">{listing.name}</h1>
          {listing.description && <p className="page-sub">{listing.description}</p>}
        </div>
        {links}
      </div>

      {yamlFailed && (
        <EmptyState title="Couldn't read the workflow file">
          <p>
            {listing.file} is listed in this implementation's index but could not be fetched.
          </p>
        </EmptyState>
      )}

      {!loaded && !yamlFailed && <p className="note">Loading…</p>}

      {loaded && !loaded.ok && (
        <div className="lint">
          <p className="empty-title">This workflow does not validate, so it cannot be run</p>
          <ul className="findings">
            {loaded.findings.map((finding, i) => (
              <li className="finding" key={`${finding.rule}-${i}`} data-severity={finding.severity}>
                <span className="finding-pos">
                  {finding.pos ? `${finding.pos.line}:${finding.pos.col}` : finding.path || '—'}
                </span>
                <span className="finding-severity">{finding.severity}</span>
                <span className="finding-rule">{finding.rule}</span>
                <span className="finding-message">{finding.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loaded?.ok && loaded.def && (
        <GraphView
          def={loaded.def}
          mode="definition"
          selectedJob={selectedJob}
          onSelect={(job) => setSelectedJob(job)}
        />
      )}

      {loaded?.ok && loaded.def && selectedJob !== null && loaded.def.jobs[selectedJob] && (
        <DeclaredJob key={selectedJob} def={loaded.def} job={selectedJob} />
      )}

      {runs && runs.length > 0 && (
        <section className="recent">
          <h2 className="section-title">Recent runs</h2>
          <ul className="rows">
            {runs.slice(0, RECENT).map((run) => (
              <li className="row" key={run.runId}>
                <div className="row-head">
                  <StatusPill status={run.status} />
                  <Link className="row-title mono" to={`runs/${run.runId}`}>
                    {run.runId}
                  </Link>
                  <span className="row-when">{new Date(run.startedAt).toLocaleString()}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}
