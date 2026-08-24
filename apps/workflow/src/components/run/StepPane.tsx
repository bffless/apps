/**
 * One step of a run, in the prototype's three tabs (08).
 *
 * **Input** is the `with` the engine actually evaluated, entry by entry, each
 * labelled with where its value came from — the origin is read off the *sub*
 * declaration that produced that entry (`with.body`, `with.fields`), not off
 * the entry's name, because a pipeline step's persisted inputs are `path`/
 * `body`, while the expressions inside them reference `inputs.greeting` or
 * `needs.greet.outputs.lines`.
 *
 * **Output** shows what the step *declared*, through the declared renderer — so
 * a `markdown` output renders as markdown even though the row stores a string.
 *
 * **Details** is the audit trail: only stamps the row actually holds are shown
 * with a time (a row keeps `startedAt`/`finishedAt` and nothing else), the
 * retried error stays visible on a step that went on to succeed, and the raw
 * response sits behind a disclosure because it can be 256 KB.
 *
 * A `form` step in `waiting` is the one exception to all of the above (08:
 * "the pane is the form") — but only while `live` is true, i.e. this run is
 * the one this tab is actually driving. A *read-only* replay of a waiting
 * form step (another tab's in-flight run, or one this tab used to drive and
 * has since navigated away from) falls back to the ordinary tabbed view
 * instead: `runEvent` carries no `runId` (`lib/runner/types.ts`), so a submit
 * from a read-only pane would dispatch into whatever run the *global*
 * `runSlice` currently holds live — silently mutating an unrelated run if
 * this tab happens to be driving a different one that shares the step key
 * (near-certain for two runs of the same workflow). Per this file's own
 * philosophy: an action that cannot be honoured is worse than an action that
 * is not offered yet.
 */
import { useState } from 'react'
import { stepOutputNames } from '@bffless/workflow-lint/definition'
import { stepOutputDecl } from '../../lib/outputDecls'
import { refsIn } from '../../lib/runner/graph'
import type { ValueRef } from '../../lib/runner/graph'
import type { Definition, RunState, Step, StepKey, StepState } from '../../lib/runner/types'
import { StatusPill } from '../StatusPill'
import { MarkdownView } from '../values/MarkdownView'
import { ValueView } from '../values/ValueView'
import type { ValueDecl } from '../values/ValueView'
import { isFileRef } from '../values/fileRef'
import { FormStepPane } from './FormStepPane'

type Tab = 'Input' | 'Output' | 'Details'
const TABS: Tab[] = ['Input', 'Output', 'Details']

/** `greet/1/say` → its parts; a step id cannot contain `/`, so the split is exact. */
function parseKey(key: StepKey): { job: string; index: number; stepId: string } | null {
  const [job, index, ...rest] = key.split('/')
  if (job === undefined || index === undefined || rest.length === 0) return null
  const parsed = Number(index)
  return Number.isInteger(parsed) ? { job, index: parsed, stepId: rest.join('/') } : null
}

/** What renderer a *recorded* value asks for when nothing declared one (02). */
function inferDecl(value: unknown): ValueDecl {
  if (isFileRef(value)) return { type: 'file' }
  if (Array.isArray(value)) {
    const first = value.find((item) => item !== null && item !== undefined)
    return { ...inferDecl(first), list: true }
  }
  if (value !== null && typeof value === 'object') return { type: 'json' }
  if (typeof value === 'number') return { type: 'number' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  return { type: 'string' }
}

/** "from `<job>/<step>`" / "from `<job>` job output" / "from `inputs.<name>`" (08). */
function originLabel(job: string, ref: ValueRef): string {
  if (ref.context === 'inputs') return `inputs.${ref.name}`
  if (ref.context === 'needs') return `${ref.name} job output`
  return `${job}/${ref.name}`
}

function originOf(job: string, declared: unknown): string | undefined {
  const labels = refsIn(declared).map((ref) => originLabel(job, ref))
  return labels.length > 0 ? labels.join(', ') : undefined
}

function InputTab({ job, step, declared }: { job: string; step: StepState; declared?: Step }) {
  const entries = Object.entries(step.inputs ?? {})
  if (entries.length === 0) return <p className="note">This step evaluated no inputs.</p>

  return (
    <div className="pane-values">
      {entries.map(([name, value]) => (
        <ValueView
          key={name}
          label={name}
          decl={inferDecl(value)}
          value={value}
          origin={originOf(job, declared?.raw?.with?.[name])}
        />
      ))}
    </div>
  )
}

function OutputTab({ step, declared }: { step: StepState; declared?: Step }) {
  const recorded = step.outputs ?? {}
  const names = (declared && stepOutputNames(declared)) ?? Object.keys(recorded)
  if (names.length === 0) return <p className="note">This step declares no outputs.</p>

  return (
    <div className="pane-values">
      {names.map((name) => {
        // A pipeline step with no `outputs` map exposes the response itself (03).
        const value =
          name in recorded ? recorded[name] : (step.response?.last ?? step.response?.initial ?? null)
        const declaredDecl = declared ? stepOutputDecl(declared, name) : { type: 'json' }
        const decl =
          declaredDecl.type === 'json' && !declaredDecl.list && isFileRef(value)
            ? { type: 'file' }
            : declaredDecl
        return <ValueView key={name} label={name} decl={decl} value={value} />
      })}
    </div>
  )
}

/** The stamps the row holds, in the order they happened. */
function timeline(step: StepState): { label: string; at?: number }[] {
  const entries: { label: string; at?: number }[] = [{ label: 'Queued' }]
  if (step.startedAt !== undefined) entries.push({ label: 'Started', at: step.startedAt })
  if (step.finishedAt !== undefined) entries.push({ label: 'Finished', at: step.finishedAt })
  return entries
}

function DetailsTab({ step, declared }: { step: StepState; declared?: Step }) {
  const path = declared?.raw?.with?.path
  const raw = step.response?.last ?? step.response?.initial

  return (
    <div className="pane-details">
      <ol className="timeline">
        {timeline(step).map((entry) => (
          <li className="timeline-entry" key={entry.label}>
            <span className="timeline-label">{entry.label}</span>
            <span className="timeline-at">
              {entry.at === undefined ? '—' : new Date(entry.at).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ol>

      <dl className="details">
        <dt>Status</dt>
        <dd>
          <StatusPill status={step.status} />
        </dd>
        <dt>Attempt</dt>
        <dd>Attempt {step.attempt}</dd>
        <dt>Kind</dt>
        <dd>{step.kind}</dd>
        {typeof path === 'string' && (
          <>
            <dt>Pipeline path</dt>
            <dd>{path}</dd>
          </>
        )}
      </dl>

      {step.error && (
        <div className="step-error" data-severity={step.status === 'failed' ? 'error' : 'warning'}>
          <p className="step-error-head">
            {step.status === 'failed' ? 'Failed' : 'Retried after'}: {step.error.code}
            {step.error.status === undefined ? '' : ` (${step.error.status})`}
          </p>
          <p className="step-error-message">{step.error.message}</p>
        </div>
      )}

      {raw !== undefined && raw !== null && (
        <details className="raw-response">
          <summary>Raw response{step.response?.truncated ? ' (truncated)' : ''}</summary>
          <pre className="declaration">{JSON.stringify(raw, null, 2)}</pre>
        </details>
      )}

      {step.summary && (
        <section className="pane-summary">
          <h4 className="section-title">Summary</h4>
          <MarkdownView value={step.summary} />
        </section>
      )}

      {step.annotations.length > 0 && (
        <ul className="annotations">
          {step.annotations.map((annotation, i) => (
            <li className="annotation" key={i} data-level={annotation.level}>
              <span className="badge" data-severity={annotation.level}>
                {annotation.level}
              </span>
              {annotation.title && <span className="annotation-title">{annotation.title}</span>}
              <span className="annotation-message">{annotation.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export interface StepPaneProps {
  def: Definition
  state: RunState
  stepKey: StepKey
  /** This run is the one this tab is driving (`RunPage`'s own `isLive`) — gates the `FormStepPane` delegation below. */
  live: boolean
}

export function StepPane({ def, state, stepKey, live }: StepPaneProps) {
  const [tab, setTab] = useState<Tab>('Input')

  const parts = parseKey(stepKey)
  const step = state.steps[stepKey]
  const declared = parts
    ? def.jobs[parts.job]?.steps.find((candidate) => candidate.id === parts.stepId)
    : undefined

  if (!parts || !step) {
    return (
      <aside className="step-pane" data-testid="step-pane" aria-label="Step">
        <h3 className="graph-panel-title">{stepKey}</h3>
        <p className="note">This run has no record of that step.</p>
      </aside>
    )
  }

  if (live && declared?.uses === 'form' && step.status === 'waiting') {
    return <FormStepPane def={def} state={state} stepKey={stepKey} />
  }

  return (
    <aside className="step-pane" data-testid="step-pane" aria-label="Step">
      <header className="graph-panel-head">
        <h3 className="graph-panel-title">{stepKey}</h3>
        <StatusPill status={step.status} />
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((name) => (
          <button
            type="button"
            role="tab"
            className="tab"
            key={name}
            aria-selected={tab === name}
            aria-controls="step-pane-body"
            id={`step-pane-tab-${name}`}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>

      <div
        className="pane-body"
        id="step-pane-body"
        role="tabpanel"
        aria-labelledby={`step-pane-tab-${tab}`}
      >
        {tab === 'Input' && <InputTab job={parts.job} step={step} declared={declared} />}
        {tab === 'Output' && <OutputTab step={step} declared={declared} />}
        {tab === 'Details' && <DetailsTab step={step} declared={declared} />}
      </div>
    </aside>
  )
}
