/**
 * One job of a run, as the middle level of the taxonomy (08: run › job › step)
 * — the same card as the run and the step, with the same **Input | Output**
 * toggle.
 *
 * **Input** is what the job waited on: its `needs`, each upstream job's
 * evaluated outputs as this job's expressions see them (`needs.<job>.outputs`).
 *
 * **Output** is the job's own declared `outputs:` — aliases over its steps'
 * outputs, collected into lists for a matrix job — evaluated the way every
 * downstream `needs.<job>.outputs.<name>` reads them (`buildRunContexts`).
 * Job outputs are derived, never persisted (05), so this is the one place a
 * person can see them as values.
 *
 * The trail lists the job's steps (status glyph, label, duration), each a way
 * down to that step's pane.
 */
import { useState } from 'react'
import { formatDuration } from '../../lib/duration'
import { resolveOutputDecl } from '../../lib/outputDecls'
import { buildRunContexts } from '../../lib/runner/contexts'
import { dataFlowEdges } from '../../lib/runner/graph'
import type { Definition, RunState, Step, StepKey, StepState } from '../../lib/runner/types'
import { stepKey } from '../../lib/runner/types'
import { StatusGlyph, StatusPill } from '../StatusPill'
import { jobLabel, matrixNote, stepLabel } from '../graph/geometry'
import { ValueView } from '../values/ValueView'
import type { ValueDecl } from '../values/ValueView'
import { isFileRef } from '../values/fileRef'
import { PaneCrumbs } from './PaneCrumbs'
import type { Tab } from './StepPane'

const TABS: Tab[] = ['Input', 'Output']

/** A bare `${{ … }}` output can only be known to be a file by its value (02). */
function withValue(decl: ValueDecl, value: unknown): ValueDecl {
  return decl.type === 'json' && !decl.list && isFileRef(value) ? { type: 'file' } : decl
}

/** The mono tag beside a value's name: its declared type, and its renderer when named. */
function kindTag(decl: ValueDecl): string {
  const base = `${decl.type}${decl.list ? ' · list' : ''}`
  return typeof decl.render === 'string' ? `${base} · ${decl.render}` : base
}

/** "goes to `<job>/<step>`, …" — every step whose expressions read this job output. */
function destinationOf(def: Definition, job: string, output: string): string | undefined {
  const targets = dataFlowEdges(def)
    .filter((edge) => edge.from.job === job && edge.from.step === undefined && edge.from.output === output)
    .map((edge) => `${edge.to.job}/${edge.to.step}`)
  const unique = [...new Set(targets)]
  return unique.length > 0 ? unique.join(', ') : undefined
}

/** The job's status, as the pill reads it: the worst of its steps, `queued` before any ran. */
function jobStatus(steps: StepState[]): StepState['status'] {
  if (steps.some((s) => s.status === 'failed')) return 'failed'
  if (steps.some((s) => s.status === 'cancelled')) return 'cancelled'
  if (steps.some((s) => s.status === 'waiting')) return 'waiting'
  if (steps.some((s) => s.status === 'running' || s.status === 'polling')) return 'running'
  if (steps.length > 0 && steps.every((s) => s.status === 'succeeded' || s.status === 'skipped')) {
    return steps.every((s) => s.status === 'skipped') ? 'skipped' : 'succeeded'
  }
  return 'queued'
}

export interface JobPaneProps {
  def: Definition
  state: RunState
  job: string
  /** Overrides `ImplContext` — only `render: island` outputs read it (`ValueView`). */
  impl?: string
  /** A step row's click: drill down to that step's pane. */
  onSelect: (key: StepKey) => void
  /** Up one level, to the run card. */
  onBack: () => void
  initialTab?: Tab
}

export function JobPane({ def, state, job, impl, onSelect, onBack, initialTab = 'Output' }: JobPaneProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const decl = def.jobs[job]

  if (!decl) {
    return (
      <aside className="step-pane job-pane" data-testid="job-pane" aria-label="Job">
        <header className="pane-head">
          <span className="pane-title">
            <PaneCrumbs trail={[{ label: 'Run', onClick: onBack }]} current={job} />
            <h3 className="graph-panel-title">{job}</h3>
          </span>
        </header>
        <p className="note">This workflow declares no such job.</p>
      </aside>
    )
  }

  const total = state.expansions[job]?.total ?? 1
  const items = Array.from({ length: total }, (_, i) => i)
  const rows: { key: StepKey; step: Step; index: number; state: StepState | undefined }[] = items.flatMap(
    (index) =>
      decl.steps.map((step) => {
        const key = stepKey(job, index, step.id)
        return { key, step, index, state: state.steps[key] }
      }),
  )
  const status = jobStatus(rows.flatMap((row) => (row.state ? [row.state] : [])))

  // Evaluated the way `jobs.<job>.outputs` / `needs.<job>.outputs` read them.
  const runCtx = buildRunContexts(def, state) as { jobs?: Record<string, { outputs: Record<string, unknown> | null }> }
  const outputs = runCtx.jobs?.[job]?.outputs ?? null
  const outputNames = Object.keys(decl.outputs ?? {})
  const needs = decl.needs ?? []
  const note = matrixNote(decl)

  return (
    <aside className="step-pane job-pane" data-testid="job-pane" aria-label="Job">
      <header className="pane-head">
        <span className="pane-title">
          <PaneCrumbs
            trail={[{ label: 'Run', onClick: onBack }]}
            current={jobLabel(decl)}
            note={note?.toLowerCase()}
          />
          <h3 className="graph-panel-title">{jobLabel(decl)}</h3>
          <span className="pane-key">{job}</span>
        </span>

        <div className="segmented" role="tablist" aria-label="Side">
          {TABS.map((name) => (
            <button
              type="button"
              role="tab"
              className="tab"
              key={name}
              aria-selected={tab === name}
              aria-controls="job-pane-body"
              id={`job-pane-tab-${name}`}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>

        <StatusPill status={status} />
        <span className="pane-kind">{decl.matrix ? `matrix · ${total} ${total === 1 ? 'item' : 'items'}` : 'job'}</span>
      </header>

      <div className="pane-body" id="job-pane-body" role="tabpanel" aria-labelledby={`job-pane-tab-${tab}`}>
        {tab === 'Input' &&
          (needs.length === 0 ? (
            <p className="note">This job needs nothing — it starts with the run.</p>
          ) : (
            <div className="pane-values">
              {needs.map((need) => {
                const upstream = runCtx.jobs?.[need]?.outputs ?? null
                const names = Object.keys(def.jobs[need]?.outputs ?? {})
                return (
                  <ValueView
                    key={need}
                    label={need}
                    tag={names.length === 0 ? 'job · no outputs' : `job · ${names.length} ${names.length === 1 ? 'output' : 'outputs'}`}
                    decl={{ type: 'json' }}
                    value={upstream}
                    origin={`${def.jobs[need] ? jobLabel(def.jobs[need]!) : need} job output`}
                  />
                )
              })}
            </div>
          ))}

        {tab === 'Output' && (
          <>
            {outputNames.length === 0 ? (
              <p className="note">This job declares no outputs of its own — its steps' outputs are on each step.</p>
            ) : (
              <div className="pane-values">
                {outputNames.map((name) => {
                  const value = outputs?.[name] ?? null
                  const d = withValue(resolveOutputDecl(def, { kind: 'job', job }, name), value)
                  return (
                    <ValueView
                      key={name}
                      label={name}
                      tag={kindTag(d)}
                      decl={d}
                      value={value}
                      impl={impl}
                      destination={destinationOf(def, job, name)}
                    />
                  )
                })}
              </div>
            )}

            <div className="pane-trail">
              <h4 className="section-title">Steps</h4>
              <ul className="job-pane-steps">
                {rows.map(({ key, step, index, state: s }) => {
                  const elapsed =
                    s?.startedAt !== undefined && s?.finishedAt !== undefined ? s.finishedAt - s.startedAt : undefined
                  return (
                    <li key={key}>
                      <button type="button" className="job-pane-step" onClick={() => onSelect(key)}>
                        <StatusGlyph status={s?.status ?? 'queued'} />
                        <span className="job-pane-step-label">
                          <span className="step-title">{stepLabel(step)}</span>
                          <span className="step-id">{key}</span>
                        </span>
                        {decl.matrix && <span className="badge">item {index + 1}</span>}
                        <span className="step-meta">{elapsed === undefined ? (s?.status ?? 'queued') : formatDuration(elapsed)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
