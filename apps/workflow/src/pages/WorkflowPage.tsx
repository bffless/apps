/**
 * One workflow, before it runs (08): the definition graph, the way into a run,
 * and the runs already behind it.
 *
 * A workflow that does not validate still gets a screen — it lists what the
 * linter said and offers no Start, because "the workflow appears with the lint
 * error and no Start" is the only honest thing to show: a definition the engine
 * cannot load is one it must not be asked to run.
 */
import { useMemo } from 'react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { Link } from 'react-router-dom'
import { DiscoveryError } from '../components/DiscoveryError'
import { EmptyState } from '../components/EmptyState'
import { StatusPill } from '../components/StatusPill'
import { GraphView } from '../components/graph/GraphView'
import { workflowId } from '../lib/coerce'
import { loadWorkflow } from '../lib/runner/definition'
import { useWorkflowListing } from '../store/useWorkflowListing'
import { useGetWorkflowYamlQuery, useListRunsQuery } from '../store/workflowApi'

/** The most recent runs shown inline; the rest live on Past runs. */
const RECENT = 5

export function WorkflowPage() {
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
          <Link to="..">Back to its workflows</Link>
        </p>
      </EmptyState>
    )
  }

  const links = (
    <nav className="page-actions">
      {loaded?.ok && <Link to="run">Start a run</Link>}
      <Link to="runs">Past runs</Link>
      <Link to="file">View workflow file</Link>
    </nav>
  )

  return (
    <section className="page">
      <h1 className="page-title">{listing.name}</h1>
      {listing.description && <p className="row-desc">{listing.description}</p>}

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

      {loaded?.ok && loaded.def && <GraphView def={loaded.def} mode="definition" />}

      {links}

      {runs && runs.length > 0 && (
        <section className="recent">
          <h2 className="section-title">Recent runs</h2>
          <ul className="rows">
            {runs.slice(0, RECENT).map((run) => (
              <li className="row" key={run.runId}>
                <div className="row-head">
                  <Link className="row-title" to={`runs/${run.runId}`}>
                    {run.runId}
                  </Link>
                  <StatusPill status={run.status} />
                </div>
                <p className="row-desc">{new Date(run.startedAt).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  )
}
