/**
 * Start a run (08): the form from `on.manual.inputs`. A workflow that does
 * not validate gets the same no-Start lint report as the workflow page
 * (Task 14) — a definition the engine cannot load is one it must not be
 * asked to run.
 *
 * `?from=<runId>` (Re-run, 08) prefills the form from that run's own
 * `inputs`; its File refs are reused untouched, no re-upload.
 */
import { useMemo } from 'react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { DiscoveryError } from '../components/DiscoveryError'
import { EmptyState } from '../components/EmptyState'
import { KickoffForm } from '../components/kickoff/KickoffForm'
import { workflowId } from '../lib/coerce'
import { loadWorkflow } from '../lib/runner/definition'
import { uploadFile } from '../lib/upload'
import { useAppDispatch } from '../store/hooks'
import { startRun } from '../store/runnerActions'
import { useWorkflowListing } from '../store/useWorkflowListing'
import { useGetRunQuery, useGetWorkflowYamlQuery } from '../store/workflowApi'
import type { FileRef } from '../lib/runner/types'

export function KickoffPage() {
  const { impl: alias, workflow } = useParams()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const [searchParams] = useSearchParams()
  const from = searchParams.get('from') ?? undefined

  const { impl, listing, isLoading, isError, error } = useWorkflowListing()

  const target = impl && listing ? { impl: impl.alias, file: listing.file } : skipToken
  const { data: yaml, isError: yamlFailed } = useGetWorkflowYamlQuery(target)

  const { data: previousRun } = useGetRunQuery(from ?? skipToken)

  const loaded = useMemo(
    () => (yaml !== undefined && listing ? loadWorkflow(yaml, listing.file) : null),
    [yaml, listing],
  )

  if (isLoading) return <p className="note">Loading…</p>
  if (isError) return <DiscoveryError error={error} />
  if (!impl || !listing) {
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

  // `workflow` (the route param) already equals this whenever `listing` was
  // found (`useWorkflowListing` matches on it) — computed directly here so
  // this page never trusts a raw filename as the id (R1).
  const wfId = workflow ?? workflowId(listing.file)

  function upload(file: File, onProgress: (fraction: number) => void): Promise<FileRef> {
    return uploadFile({ impl: impl!.alias, workflow: wfId, scope: 'inputs', file, onProgress })
  }

  function handleStart(values: Record<string, unknown>) {
    if (!loaded?.ok || !loaded.def) return
    const runId = dispatch(
      startRun({
        impl: impl!.alias,
        workflow: wfId,
        def: loaded.def,
        yaml: loaded.yaml,
        workflowName: loaded.def.name,
        ...(impl!.version === undefined ? {} : { workflowVersion: impl!.version }),
        values,
      }),
    )
    navigate(`/${impl!.alias}/${wfId}/runs/${runId}`)
  }

  return (
    <section className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-title">Start a run</h1>
          <p className="page-sub">{loaded?.def?.name ?? listing.name}</p>
        </div>
      </div>

      {yamlFailed && (
        <EmptyState title="Couldn't read the workflow file">
          <p>{listing.file} is listed in this implementation's index but could not be fetched.</p>
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
        <div className="panel form-panel">
          <KickoffForm
            inputs={loaded.def.inputs}
            initial={previousRun?.run?.inputs}
            uploading={upload}
            onStart={handleStart}
          />
        </div>
      )}
    </section>
  )
}
