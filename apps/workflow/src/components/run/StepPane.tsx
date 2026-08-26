/**
 * One step of a run, as the prototype's **Input | Output** toggle (08).
 *
 * **Input** is the `with` the engine actually evaluated, entry by entry, each
 * labelled with where its value came from — the origin is read off the *sub*
 * declaration that produced that entry (`with.body`, `with.fields`), not off
 * the entry's name, because a pipeline step's persisted inputs are `path`/
 * `body`, while the expressions inside them reference `inputs.greeting` or
 * `needs.greet.outputs.lines`.
 *
 * **Output** shows what the step *declared*, through the declared renderer — so
 * a `markdown` output renders as markdown even though the row stores a string
 * — each chip saying where it goes next. The audit trail that used to be a
 * third `Details` tab rides on Output (decided 2026-08-26): the stamps the row
 * actually holds (a row keeps `startedAt`/`finishedAt` and nothing else), the
 * attempt, the pipeline path, the retried error that stays visible on a step
 * that went on to succeed, the summary, the annotations, a live script's log,
 * and the raw response behind a disclosure because it can be 256 KB.
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
import { useEffect, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { stepOutputNames } from '@bffless/workflow-lint/definition'
import { formatDuration } from '../../lib/duration'
import { stepOutputDecl } from '../../lib/outputDecls'
import { dataFlowEdges, refsIn } from '../../lib/runner/graph'
import type { ValueRef } from '../../lib/runner/graph'
import type { Definition, RunState, Step, StepKey, StepState } from '../../lib/runner/types'
import { useAppDispatch } from '../../store/hooks'
import { valueHovered } from '../../store/uiSlice'
import { StatusPill } from '../StatusPill'
import { jobLabel, stepLabel } from '../graph/geometry'
import { MarkdownView } from '../values/MarkdownView'
import { MediaSeekProvider } from '../values/MediaSeekContext'
import { ValueView } from '../values/ValueView'
import type { ValueDecl } from '../values/ValueView'
import { isFileRef } from '../values/fileRef'
import { BackToRun } from './BackToRun'
import { FormStepPane } from './FormStepPane'
import { IslandStepPane } from './IslandStepPane'
import { ScriptStepCard } from './ScriptStepCard'

export type Tab = 'Input' | 'Output'
const TABS: Tab[] = ['Input', 'Output']

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

/**
 * "goes to `<job>/<step>`, …" — every step whose expressions read this output
 * (08), directly (`steps.<id>.outputs.<o>` inside the same job) or through a
 * job-level alias (`outputs: { o: ${{ steps.<id>.outputs.<o> }} }`, then
 * `needs.<job>.outputs.<o>` downstream) — the way every cross-job read in the
 * hello workflow actually happens.
 */
function destinationOf(def: Definition, step: StepState, output: string): string | undefined {
  const jobOutputs = (def.jobs[step.job]?.raw?.outputs ?? null) as Record<string, unknown> | null
  const aliases = new Set(
    Object.entries(jobOutputs ?? {})
      .filter(([, expr]) =>
        refsIn(expr).some(
          (ref) => ref.context === 'steps' && ref.name === step.stepId && ref.output === output,
        ),
      )
      .map(([alias]) => alias),
  )
  const targets = dataFlowEdges(def)
    .filter((edge) => {
      if (edge.from.job !== step.job) return false
      if (edge.from.step === undefined) return aliases.has(edge.from.output)
      return edge.from.step === step.stepId && edge.from.output === output
    })
    .map((edge) => `${edge.to.job}/${edge.to.step}`)
  const unique = [...new Set(targets)]
  return unique.length > 0 ? unique.join(', ') : undefined
}

/** The mono tag beside a value's name: its declared type, and its renderer when named. */
function kindTag(decl: ValueDecl): string {
  const base = `${decl.type}${decl.list ? ' · list' : ''}`
  return typeof decl.render === 'string' ? `${base} · ${decl.render}` : base
}

// `origin` above is one joined string per entry — a pipeline step's `with`
// can read several upstream values into one persisted input (`body.lines`
// *and* `body.photo`, say), so a single origin chip has no one `ValueRef` to
// hand `onHover` as the hovered value's identity. Wiring hover here would
// need one chip per ref, which is a bigger change than this task's `onHover`
// plumbing; the Output tab below is the hover source Task 22 wires up.
function InputTab({ job, step, declared }: { job: string; step: StepState; declared?: Step }) {
  const entries = Object.entries(step.inputs ?? {})
  if (entries.length === 0) return <p className="note">This step evaluated no inputs.</p>

  return (
    <div className="pane-values">
      {entries.map(([name, value]) => {
        const decl = inferDecl(value)
        return (
          <ValueView
            key={name}
            label={name}
            tag={kindTag(decl)}
            decl={decl}
            value={value}
            origin={originOf(job, declared?.raw?.with?.[name])}
          />
        )
      })}
    </div>
  )
}

function OutputValues({
  def,
  step,
  declared,
  impl,
}: {
  def: Definition
  step: StepState
  declared?: Step
  /** Overrides `ImplContext` — only `render: island` outputs read it (`ValueView`). */
  impl?: string
}) {
  const recorded = step.outputs ?? {}
  const names = (declared && stepOutputNames(declared)) ?? Object.keys(recorded)
  const dispatch = useAppDispatch()
  // A hover this tab leaves mid-flight — the tab switched, another step got
  // selected (StepPane is remounted with `key={selectedStep}`) — must not
  // outlive the pointer leaving the DOM node that set it: `onMouseLeave`
  // never fires for an element that was unmounted out from under the cursor.
  useEffect(
    () => () => {
      dispatch(valueHovered(null))
    },
    [dispatch],
  )
  if (names.length === 0) return <p className="note">This step declares no outputs.</p>

  return (
    // Scoped to this one step, so a transcript's seek click always lands on
    // the player showing in the same step's Output tab (Task 15).
    <MediaSeekProvider>
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
          return (
            <ValueView
              key={name}
              label={name}
              tag={kindTag(decl)}
              decl={decl}
              value={value}
              impl={impl}
              destination={destinationOf(def, step, name)}
              // This step's own output is the value's declaring chip (08's
              // data-flow highlight) — the graph lights up wherever else it's read.
              onHover={(hovering) =>
                dispatch(
                  valueHovered(hovering ? { job: step.job, step: step.stepId, output: name } : null),
                )
              }
            />
          )
        })}
      </div>
    </MediaSeekProvider>
  )
}

/** `14:06:02` — the wall-clock stamp the row holds, in the reader's locale. */
function clock(at: number | undefined): string {
  return at === undefined ? '—' : new Date(at).toLocaleTimeString()
}

/**
 * The audit trail, folded into Output: only stamps the row actually holds are
 * shown with a time, the retried error stays visible on a step that went on to
 * succeed, and the raw response sits behind a disclosure.
 */
function Details({ step, declared }: { step: StepState; declared?: Step }) {
  const path = declared?.raw?.with?.path
  const took =
    step.startedAt !== undefined && step.finishedAt !== undefined
      ? formatDuration(step.finishedAt - step.startedAt)
      : undefined

  return (
    <>
      <dl className="stats">
        <div className="stat">
          <dt>Started</dt>
          <dd>{clock(step.startedAt)}</dd>
        </div>
        <div className="stat">
          <dt>Finished</dt>
          <dd>{clock(step.finishedAt)}</dd>
        </div>
        <div className="stat">
          <dt>Took</dt>
          <dd>{took ?? '—'}</dd>
        </div>
        <div className="stat">
          <dt>Attempt</dt>
          <dd>Attempt {step.attempt}</dd>
        </div>
        <div className="stat">
          <dt>Kind</dt>
          <dd>{step.kind}</dd>
        </div>
        {typeof path === 'string' && (
          <div className="stat">
            <dt>Pipeline</dt>
            <dd>{path}</dd>
          </div>
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
    </>
  )
}

function Trail({
  step,
  scriptLog,
}: {
  step: StepState
  /** A live script step's log card — `undefined` for every other step (see `StepPane`). */
  scriptLog?: ReactNode
}) {
  const raw = step.response?.last ?? step.response?.initial
  const hasTrail =
    scriptLog !== undefined ||
    step.summary !== undefined ||
    step.annotations.length > 0 ||
    (raw !== undefined && raw !== null)
  if (!hasTrail) return null

  return (
    <div className="pane-trail">
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

      {scriptLog}

      {raw !== undefined && raw !== null && (
        <details className="raw-response">
          <summary>Raw response{step.response?.truncated ? ' (truncated)' : ''}</summary>
          <pre className="declaration">{JSON.stringify(raw, null, 2)}</pre>
        </details>
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
  /** Which side opens first — an edge dot's click says (08); a chip's click leaves it on Input. */
  initialTab?: Tab
  /** Up one level (08: run › job › step): the pane's "← <job>" button, and Esc anywhere inside it. */
  onBack?: () => void
  /** Straight to the run card — the crumb's first segment. */
  onRun?: () => void
}

export function StepPane({ def, state, stepKey, live, initialTab = 'Input', onBack, onRun }: StepPaneProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && onBack) {
      event.stopPropagation()
      onBack()
    }
  }

  const parts = parseKey(stepKey)
  const step = state.steps[stepKey]
  const job = parts ? def.jobs[parts.job] : undefined
  const declared = parts ? job?.steps.find((candidate) => candidate.id === parts.stepId) : undefined

  if (!parts || !step) {
    return (
      <aside className="step-pane" data-testid="step-pane" aria-label="Step" onKeyDown={onKeyDown}>
        <header className="pane-head">
          <BackToRun onBack={onBack} />
          <h3 className="graph-panel-title">{stepKey}</h3>
        </header>
        <p className="note">This run has no record of that step.</p>
      </aside>
    )
  }

  if (live && declared?.uses === 'form' && step.status === 'waiting') {
    return <FormStepPane def={def} state={state} stepKey={stepKey} onBack={onBack} backLabel={job ? jobLabel(job) : parts.job} />
  }

  // An island is the pane from the moment it starts loading, not only once it
  // is `waiting`: the pane owns the iframe, so nothing can *reach* `waiting`
  // until it has rendered (Decision 11). Read-only falls back to tabs for the
  // same reason a read-only form does — a submit from here would land on
  // whatever run the global slice holds live.
  if (live && declared?.uses === 'island' && (step.status === 'running' || step.status === 'waiting')) {
    return <IslandStepPane state={state} stepKey={stepKey} onBack={onBack} backLabel={job ? jobLabel(job) : parts.job} />
  }

  // The eyebrow is the crumb: Run › <job> (· item n of N for a fanned-out job).
  // Each segment is a way up; the Back button is the nearest one.
  const total = state.expansions[parts.job]?.total
  const jobName = job ? jobLabel(job) : parts.job
  const item = job?.matrix !== undefined && total !== undefined ? ` · item ${parts.index + 1} of ${total}` : ''

  // A script has no pane of its own — its live `ctx.log` rides on Output
  // instead, whatever the step's status (a finished script's lines stay until
  // the runner resets). Live only, like the island log: the lines belong to
  // the run *this* tab is driving, and a read-only replay of another run's
  // step has none of them.
  const scriptLog =
    live && declared?.uses === 'script' ? <ScriptStepCard runId={state.runId} stepKey={stepKey} /> : undefined

  return (
    <aside className="step-pane" data-testid="step-pane" aria-label="Step" onKeyDown={onKeyDown}>
      <header className="pane-head">
        <BackToRun onBack={onBack} label={jobName} />
        <span className="pane-title">
          <span className="pane-eyebrow pane-crumbs">
            {onRun ? (
              <button type="button" className="pane-crumb" onClick={onRun}>
                Run
              </button>
            ) : (
              <span>Run</span>
            )}
            <span className="pane-crumb-sep" aria-hidden="true">
              ›
            </span>
            {onBack ? (
              <button type="button" className="pane-crumb" onClick={onBack}>
                {jobName}
              </button>
            ) : (
              <span>{jobName}</span>
            )}
            {item && <span>{item}</span>}
          </span>
          <h3 className="graph-panel-title">{declared ? stepLabel(declared) : parts.stepId}</h3>
          <span className="pane-key">{stepKey}</span>
        </span>

        <div className="segmented" role="tablist" aria-label="Side">
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

        <StatusPill status={step.status} />
        <span className="pane-kind">{step.kind}</span>
      </header>

      <div
        className="pane-body"
        id="step-pane-body"
        role="tabpanel"
        aria-labelledby={`step-pane-tab-${tab}`}
      >
        {tab === 'Input' && <InputTab job={parts.job} step={step} declared={declared} />}
        {tab === 'Output' && (
          <>
            <Details step={step} declared={declared} />
            <OutputValues def={def} step={step} declared={declared} impl={state.impl} />
            <Trail step={step} scriptLog={scriptLog} />
          </>
        )}
      </div>
    </aside>
  )
}
