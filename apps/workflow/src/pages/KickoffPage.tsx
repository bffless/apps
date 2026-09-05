/**
 * Start a run (08): the form from `on.manual.inputs`. A workflow that does
 * not validate gets the same no-Start lint report as the workflow page
 * (Task 14) — a definition the engine cannot load is one it must not be
 * asked to run.
 *
 * `?from=<runId>` (Re-run, 08) prefills the form from that run's own
 * `inputs`; its File refs are reused untouched, no re-upload.
 *
 * `?auto=1&inputs=<base64url(JSON)>` is the headless entry point (07/D12):
 * the same start, with the values off the URL instead of the form and nobody
 * to press Start. **Everything** it refuses reaches `window.__workflow` as
 * `status: 'invalid'` — a driver watching the global would otherwise wait out
 * its whole timeout on a run that never began. Only two of those refusals also
 * render the `kickoff-invalid` list (values that do not validate, and an
 * `inputs` parameter that does not decode); the other four — a workflow that
 * does not lint, a file that could not be read, no such implementation or
 * workflow, and a failed discovery — keep their own screens, which is why the
 * global is the contract and the testid is not (07's table).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { skipToken } from '@reduxjs/toolkit/query/react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { DiscoveryError } from '../components/DiscoveryError'
import { EmptyState } from '../components/EmptyState'
import { KickoffForm } from '../components/kickoff/KickoffForm'
import { START_REFUSALS, decodeInputs, initialValues, parseRunIdParam, validateInputs } from '../lib/autoStart'
import { offersUnattended } from '../lib/runner/headless'
import { workflowId } from '../lib/coerce'
import { loadWorkflow } from '../lib/runner/definition'
import { uploadFile } from '../lib/upload'
import { publishWorkflowGlobal } from '../lib/workflowGlobal'
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
  const auto = searchParams.get('auto') === '1'
  // `?wait=park` (07): the driver would rather the run waited for a person at a
  // step that declares no `headless:` than failed there. Only meaningful on a
  // driven start — a person's tab already waits.
  const park = auto && searchParams.get('wait') === 'park'
  const inputsParam = searchParams.get('inputs')
  const runIdRaw = searchParams.get('runId')
  // `?runId=` (07, ADR-0006): a driver mints the id before this page even
  // loads, so it can hand the id to its own caller immediately. Parsed once,
  // ahead of the inputs decode below — a malformed id is a refusal on its own,
  // never a value worth resolving `inputs` against. Annotated to the same
  // shape on both branches (rather than `parseRunIdParam`'s own return type
  // narrowed to one arm) so every read below — `.ok`, `.runId` — type-checks
  // the same regardless of `auto`. Memoized on the raw string (not `auto` and
  // `searchParams` alone) so `autoStart`, below, only recomputes when this
  // value actually changes rather than on every render.
  const runIdParam = useMemo<{ ok: true; runId?: string } | { ok: false; error: string }>(
    () => (auto ? parseRunIdParam(runIdRaw) : { ok: true }),
    [auto, runIdRaw],
  )

  const { impl, listing, isLoading, isError, error } = useWorkflowListing()

  const target = impl && listing ? { impl: impl.alias, file: listing.file } : skipToken
  const { data: yaml, isError: yamlFailed } = useGetWorkflowYamlQuery(target)

  const { data: previousRun } = useGetRunQuery(from ?? skipToken)

  // Does a run already exist under `?runId=`? Skipped whenever there is no id
  // to check — a person's start, or `?auto=1` with no `runId` at all, mints a
  // fresh one and never queries. The read, not the create rule's 409, is the
  // primary defense (the design's own ruling): the rule is only a backstop for
  // the race between this read and the insert.
  const existing = useGetRunQuery(auto && runIdParam.ok && runIdParam.runId ? runIdParam.runId : skipToken)

  const loaded = useMemo(
    () => (yaml !== undefined && listing ? loadWorkflow(yaml, listing.file) : null),
    [yaml, listing],
  )

  // One auto-start per mount. Without it, any re-render between the dispatch
  // and the navigation would start the workflow a second time.
  const started = useRef(false)

  // "Don't wait for me" (07): a run-level choice, so it lives here beside the
  // form rather than in its values — the form only renders the toggle when
  // the workflow has a step it could apply to.
  const [unattended, setUnattended] = useState(false)

  // What `?auto=1` makes of the URL — derived, not state: decoding and
  // validating are pure, so there is nothing here for an effect to
  // synchronise, and the render that shows the errors is the same render that
  // computed them.
  const autoStart = useMemo<{ values?: Record<string, unknown>; errors?: Record<string, string> } | null>(() => {
    if (!auto || !loaded?.ok || !loaded.def) return null
    // A malformed `runId=` is refused before `inputs` is even looked at: it is
    // never a value worth resolving against the declarations, and folding it
    // in here (rather than a separate check) is what keeps the auto-start
    // effect from firing on it — that effect only reads `autoStart.values`.
    if (!runIdParam.ok) return { errors: { runId: runIdParam.error } }
    const decoded = decodeInputs(inputsParam)
    if (!decoded.ok) return { errors: { inputs: decoded.error } }
    // Resolved against the declarations first, exactly as the form's own
    // initial state is: an input the driver left out takes its `default`, and
    // one the workflow does not declare is dropped rather than carried into
    // the run's `inputs`.
    const values = initialValues(loaded.def.inputs, decoded.values)
    const errors = validateInputs(loaded.def.inputs, values)
    return Object.keys(errors).length > 0 ? { errors } : { values }
  }, [auto, inputsParam, loaded, runIdParam])

  const invalid = autoStart?.errors ?? null

  function start(values: Record<string, unknown>, headless: boolean, unattendedRun = false) {
    if (!impl || !listing || !loaded?.ok || !loaded.def) return
    // `workflow` (the route param) already equals this whenever `listing` was
    // found (`useWorkflowListing` matches on it) — computed directly here so
    // this page never trusts a raw filename as the id (R1).
    const wfId = workflow ?? workflowId(listing.file)
    const runId = dispatch(
      startRun({
        impl: impl.alias,
        workflow: wfId,
        def: loaded.def,
        yaml: loaded.yaml,
        workflowName: loaded.def.name,
        ...(impl.version === undefined ? {} : { workflowVersion: impl.version }),
        values,
        headless,
        unattended: unattendedRun,
        park,
        // Only ever set on the auto path with a well-formed `runId=` — a
        // person's Start, and every other refusal, leaves this `undefined`,
        // which `startRun` reads exactly like an absent field (mints its own).
        runId: runIdParam.ok ? runIdParam.runId : undefined,
      }),
    )
    void navigate(`/${impl.alias}/${wfId}/runs/${runId}`)
  }

  useEffect(() => {
    // `existing.isLoading` holds the effect until the `?runId=` read has
    // settled — starting on the assumption that the row is fresh, then
    // finding out otherwise from the 409 backstop, would be the exact race
    // the page-side check exists to avoid. `existing.data?.run` stops it
    // outright once settled: a duplicate id publishes `invalid` (`blocked`,
    // below) instead of ever reaching `startRun`.
    if (started.current || autoStart?.values === undefined || existing.isLoading || existing.data?.run) return
    started.current = true
    start(autoStart.values, true)
    // `start` closes over this render's discovery result; the `started` guard
    // is what makes the effect run-once, so re-listing it would only re-run
    // the effect on every render for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, existing.isLoading, existing.data])

  // Every way `?auto=1` can end without a run: discovery that failed, a url
  // naming an implementation or workflow that is not there, a workflow file
  // that could not be read, a workflow that does not validate, and inputs
  // that do not. They are one fact to a driver — "this is not going to
  // start" — so every one of them publishes `invalid`, not only the ones with
  // something to render. The first two are the likeliest ways a CI run goes
  // wrong (a typo'd alias, an offline instance) *and* the two this page
  // answers with an early return above the JSX, so they would otherwise be
  // the states that hang a driver for its whole timeout.
  const blocked = useMemo<Record<string, string> | null>(() => {
    if (!auto) return null
    if (invalid) return invalid
    // Nothing has gone wrong while discovery is still in flight.
    if (isLoading) return null
    if (isError) return { discovery: START_REFUSALS.discovery }
    // One guard, because `listing` is derived from `impl`'s own workflows: no
    // such alias, or no workflow by that name in it.
    if (!impl || !listing) return { workflow: START_REFUSALS.noWorkflow }
    if (yamlFailed) return { workflow: START_REFUSALS.fileUnreadable }
    if (loaded && !loaded.ok) return { workflow: START_REFUSALS.doesNotLint }
    // `?runId=`'s own refusal (07): the id parsed fine, but a row already
    // exists under it. Checked last, not first, because it depends on a
    // network read (`existing`) the other checks don't need.
    if (existing.data?.run) return { runId: 'A run with this id already exists' }
    return null
  }, [auto, invalid, isLoading, isError, impl, listing, yamlFailed, loaded, existing.data])

  useEffect(() => {
    if (!blocked) return
    publishWorkflowGlobal({
      runId: '',
      status: 'invalid',
      currentSteps: [],
      outputs: {},
      steps: {},
      errors: blocked,
    })
    return () => publishWorkflowGlobal(null)
  }, [blocked])

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

  const wfId = workflow ?? workflowId(listing.file)

  function upload(file: File, onProgress: (fraction: number) => void): Promise<FileRef> {
    return uploadFile({ impl: impl!.alias, workflow: wfId, scope: 'inputs', file, onProgress })
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

      {!loaded && !yamlFailed && !auto && <p className="note">Loading…</p>}

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

      {auto && invalid && (
        <div className="lint" data-testid="kickoff-invalid">
          <p className="empty-title">These inputs cannot start a run</p>
          <ul className="findings">
            {Object.entries(invalid).map(([name, message]) => (
              <li className="finding" key={name} data-severity="error">
                <span className="finding-rule">{name}</span>
                <span className="finding-message">{message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Auto mode replaces the form outright: there is no Start to press, and
          a form rendered here would be one a driver could never fill in. */}
      {auto && !blocked && (
        <p className="note" data-testid="kickoff-auto">
          Starting…
        </p>
      )}

      {!auto && loaded?.ok && loaded.def && (
        <div className="panel form-panel">
          <KickoffForm
            inputs={loaded.def.inputs}
            initial={previousRun?.run?.inputs}
            uploading={upload}
            onStart={(values) => start(values, false, unattended)}
            unattended={
              offersUnattended(loaded.def) ? { value: unattended, onChange: setUnattended } : undefined
            }
          />
        </div>
      )}
    </section>
  )
}
