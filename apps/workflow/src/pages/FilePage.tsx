/**
 * "View workflow file" (08): the YAML, numbered, with the linter's verdict.
 *
 * Two sources, one screen. Normally it fetches the file the implementation
 * publishes *now*; reached from a run it renders the snapshot that run stored
 * (D16), handed over in the navigation state — because the file on the server
 * may have moved on since, and what a run did is what its own YAML says.
 *
 * It renders whatever it is given, valid or not: a file too broken to load is
 * exactly the file somebody needs to read.
 */
import { useMemo } from 'react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { useLocation } from 'react-router-dom'
import { lintSource } from '@bffless/workflow-lint/lint'
import type { Finding, Severity } from '@bffless/workflow-lint/lint'
import { DiscoveryError } from '../components/DiscoveryError'
import { EmptyState } from '../components/EmptyState'
import { pluralize } from '../lib/plural'
import { useWorkflowListing } from '../store/useWorkflowListing'
import { useGetWorkflowYamlQuery } from '../store/workflowApi'

/** The snapshot a run page hands over (D16), if this is where we came from. */
interface FileState {
  yaml?: unknown
  runId?: unknown
}

const SEVERITIES: Severity[] = ['error', 'warning', 'notice']
const HEADINGS: Record<Severity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  notice: 'Notices',
}

function Findings({ severity, findings }: { severity: Severity; findings: Finding[] }) {
  if (findings.length === 0) return null
  return (
    <section className="lint-group" data-severity={severity}>
      <h2 className="section-title">{HEADINGS[severity]}</h2>
      <ul className="findings">
        {findings.map((finding, i) => (
          <li className="finding" key={`${finding.rule}-${i}`} data-severity={severity}>
            <span className="finding-pos">
              {finding.pos ? `${finding.pos.line}:${finding.pos.col}` : finding.path || '—'}
            </span>
            <span className="finding-rule">{finding.rule}</span>
            <span className="finding-message">{finding.message}</span>
            {finding.hint && <span className="finding-hint">{finding.hint}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function FilePage() {
  const { impl, listing, isLoading, isError, error } = useWorkflowListing()
  const state = (useLocation().state ?? {}) as FileState

  const snapshot = typeof state.yaml === 'string' ? state.yaml : undefined
  const runId = typeof state.runId === 'string' ? state.runId : undefined

  const { data: fetched, isError: fetchFailed } = useGetWorkflowYamlQuery(
    snapshot === undefined && impl && listing ? { impl: impl.alias, file: listing.file } : skipToken,
  )

  const yaml = snapshot ?? fetched
  const result = useMemo(
    () => (yaml === undefined ? null : lintSource(yaml, { file: listing?.file })),
    [yaml, listing?.file],
  )

  if (isLoading) return <p className="note">Loading…</p>
  if (isError) return <DiscoveryError error={error} />
  if (!listing && snapshot === undefined) {
    return <EmptyState title="No such workflow" />
  }

  if (fetchFailed) {
    return (
      <EmptyState title="Couldn't read the workflow file">
        <p>{listing?.file} is listed in this implementation's index but could not be fetched.</p>
      </EmptyState>
    )
  }

  if (yaml === undefined || !result) return <p className="note">Loading…</p>

  const lines = yaml.replace(/\n$/, '').split('\n')

  return (
    <section className="page">
      <h1 className="page-title">{listing?.file ?? 'Workflow file'}</h1>
      {runId && <p className="note">A snapshot from run {runId}, not the file published now.</p>}

      <ul className="meta lint-counts">
        <li>{pluralize(result.counts.errors, 'error')}</li>
        <li>{pluralize(result.counts.warnings, 'warning')}</li>
        <li>{pluralize(result.counts.notices, 'notice')}</li>
      </ul>

      {SEVERITIES.map((severity) => (
        <Findings
          key={severity}
          severity={severity}
          findings={result.findings.filter((finding) => finding.severity === severity)}
        />
      ))}

      <pre className="source">
        <code>
          {lines.map((line, i) => (
            <span className="source-line" key={i}>
              <span className="source-no">{i + 1}</span>
              <span className="source-text">{line}</span>
              {'\n'}
            </span>
          ))}
        </code>
      </pre>
    </section>
  )
}
