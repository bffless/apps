/**
 * The run itself, as the outermost step (08): the card that shows under the
 * graph while no step is selected, in exactly the step pane's shape — the
 * same head, the same **Input | Output** toggle, the same value treatment.
 *
 * **Input** is what the run was started with: the kickoff form's values, each
 * through the renderer its `on.manual.inputs` declaration resolves to, so a
 * `file` input is a file row and a `choice` list is chips — the same closed
 * vocabulary a step's own inputs use.
 *
 * **Output** is what the run produced: the workflow's declared `outputs`
 * (`RunOutputs`, the run-level half only — a step's outputs are that step's
 * own pane), then the trail: every step's `summary` in job order and the
 * run's annotations, each linking back into the graph.
 *
 * The run bar in the header already carries the status, progress and elapsed
 * time, so this card does not repeat them; its head names the workflow and
 * the run, and the eyebrow says which level of the taxonomy this is.
 */
import { useState } from 'react'
import { AnnotationList } from '../AnnotationList'
import { StatusPill } from '../StatusPill'
import { ValueView } from '../values/ValueView'
import type { ValueDecl } from '../values/ValueView'
import type { Annotation, Definition, RunState, StepKey } from '../../lib/runner/types'
import { RunOutputs } from './RunOutputs'
import { RunSummary } from './RunSummary'
import type { Tab } from './StepPane'

const TABS: Tab[] = ['Input', 'Output']

/** `on.manual.inputs.<name>` (02) → the renderer its value is shown through. */
function inputDecl(def: Definition, name: string): ValueDecl {
  const declared = def.inputs?.[name] as { type?: unknown; list?: unknown } | undefined
  return {
    type: typeof declared?.type === 'string' ? declared.type : 'string',
    ...(declared?.list === true ? { list: true } : {}),
  }
}

/** The mono tag beside a value's name: its declared type. */
function kindTag(decl: ValueDecl): string {
  return `${decl.type}${decl.list ? ' · list' : ''}`
}

export interface RunPaneProps {
  def: Definition
  state: RunState
  workflowName: string
  /** Every annotation of the run, run-level and per step (the page collects them). */
  annotations: Annotation[]
  /** Overrides `ImplContext` — only `render: island` outputs read it (`ValueView`). */
  impl?: string
  /** An annotation's jump: select the step it came from. */
  onJump: (key: StepKey) => void
  /** Which side opens first; Output by default — the results are what the page is for. */
  initialTab?: Tab
}

export function RunPane({
  def,
  state,
  workflowName,
  annotations,
  impl,
  onJump,
  initialTab = 'Output',
}: RunPaneProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const inputs = Object.entries(state.inputs ?? {})

  return (
    <aside className="step-pane run-pane" data-testid="run-pane" aria-label="Run">
      <header className="pane-head">
        <span className="pane-title">
          <span className="pane-eyebrow">Run</span>
          <h3 className="graph-panel-title">{workflowName}</h3>
          <span className="pane-key">{state.runId}</span>
        </span>

        <div className="segmented" role="tablist" aria-label="Side">
          {TABS.map((name) => (
            <button
              type="button"
              role="tab"
              className="tab"
              key={name}
              aria-selected={tab === name}
              aria-controls="run-pane-body"
              id={`run-pane-tab-${name}`}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>

        <StatusPill status={state.status} />
        <span className="pane-kind">workflow</span>
      </header>

      <div className="pane-body" id="run-pane-body" role="tabpanel" aria-labelledby={`run-pane-tab-${tab}`}>
        {tab === 'Input' &&
          (inputs.length === 0 ? (
            <p className="note">This workflow takes no inputs.</p>
          ) : (
            <div className="pane-values">
              {inputs.map(([name, value]) => {
                const decl = inputDecl(def, name)
                return (
                  <ValueView
                    key={name}
                    label={name}
                    tag={kindTag(decl)}
                    decl={decl}
                    value={value}
                    origin="the kickoff form"
                  />
                )
              })}
            </div>
          ))}
        {tab === 'Output' && (
          <>
            <RunOutputs def={def} state={state} impl={impl} />
            <div className="pane-trail">
              <RunSummary def={def} state={state} />
              <AnnotationList annotations={annotations} onJump={onJump} />
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
