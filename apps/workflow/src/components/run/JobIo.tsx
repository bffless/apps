/**
 * "Job inputs and outputs" — the job's own values, folded into a disclosure
 * under the job head (spec 2026-09-08, phase 3: GitHub keeps the job's
 * envelope collapsed and gives the page to the steps).
 *
 * The body is the old `JobPane`'s, unchanged in substance:
 *
 * **Input** is what the job waited on: its `needs`, each upstream job's
 * evaluated outputs as this job's expressions see them (`needs.<job>.outputs`).
 * On one *item* of a matrix job the item's own bindings come first — `who:
 * studio` is the most specific answer to "what was this leg given", and it is
 * stated nowhere else on the page.
 *
 * **Output** is the job's own declared `outputs:` — aliases over its steps'
 * outputs, collected into lists for a matrix job — evaluated the way every
 * downstream `needs.<job>.outputs.<name>` reads them (`buildRunContexts`).
 * Job outputs are derived, never persisted (05), so this is the one place a
 * person can see them as values. On one item, each collected list is shown as
 * *that item's element* of it, so the leg's own line is not buried in the
 * whole job's list.
 *
 * The disclosure is deliberately not a native uncontrolled `<details>`, and it
 * owns neither its openness nor its side: `JobPage` holds both, next to the
 * set of open step rows, because a row click is a *navigation* — it rewrites
 * `?step=` and drops `?tab=` — and anything this component kept in its own
 * `useState` would be thrown away with it. (It was: keying the element on the
 * URL's `tab` and `index` remounted it on the first row click, snapping the
 * disclosure shut and reverting it to Input.) The summary's own click is
 * intercepted and reported up as `onToggle`, which is also what makes it
 * behave identically in jsdom and in a browser.
 */
import { outputImageMap } from '../../lib/imageMap'
import { resolveOutput } from '../../lib/outputDecls'
import { buildRunContexts } from '../../lib/runner/contexts'
import { dataFlowEdges } from '../../lib/runner/graph'
import type { Definition, RunState } from '../../lib/runner/types'
import { jobLabel } from '../graph/geometry'
import { RawToggle } from '../values/RawToggle'
import { ValueView } from '../values/ValueView'
import type { ValueDecl } from '../values/ValueView'
import { withFileRefValue } from '../values/fileRef'
import { inferDecl } from '../values/inferDecl'
import type { Tab } from './StepBody'

const TABS: Tab[] = ['Input', 'Output']

/** The mono tag beside a value's name: its declared type, and its renderer when named. */
function kindTag(decl: ValueDecl): string {
  const base = `${decl.type}${decl.list ? ' · list' : ''}`
  return typeof decl.render === 'string' ? `${base} · ${decl.render}` : base
}

/** One element of a collected list is that list's type without the list. */
function elementDecl(decl: ValueDecl): ValueDecl {
  const next = { ...decl }
  delete next.list
  return next
}

/** "goes to `<job>/<step>`, …" — every step whose expressions read this job output. */
function destinationOf(def: Definition, job: string, output: string): string | undefined {
  const targets = dataFlowEdges(def)
    .filter((edge) => edge.from.job === job && edge.from.step === undefined && edge.from.output === output)
    .map((edge) => `${edge.to.job}/${edge.to.step}`)
  const unique = [...new Set(targets)]
  return unique.length > 0 ? unique.join(', ') : undefined
}

export interface JobIoProps {
  def: Definition
  state: RunState
  job: string
  /** One item of a matrix job: its own bindings on Input, its element of each collected output. */
  index?: number
  /** Overrides `ImplContext` — only `render: island` outputs read it (`ValueView`). */
  impl?: string
  /** Which side is showing — an edge dot's click says which one opens (08). */
  tab: Tab
  onTab: (tab: Tab) => void
  /** Open — an edge dot asked for a side, so the side has to be showing. */
  open: boolean
  onToggle: () => void
}

export function JobIo({ def, state, job, index, impl, tab, onTab, open, onToggle }: JobIoProps) {
  const decl = def.jobs[job]

  // Evaluated the way `jobs.<job>.outputs` / `needs.<job>.outputs` read them.
  const runCtx = buildRunContexts(def, state) as { jobs?: Record<string, { outputs: Record<string, unknown> | null }> }
  const outputs = runCtx.jobs?.[job]?.outputs ?? null
  const outputNames = Object.keys(decl?.outputs ?? {})
  const needs = decl?.needs ?? []
  const bindings = index === undefined ? {} : (state.expansions[job]?.items[index] ?? {})
  const bindingNames = Object.keys(bindings)

  return (
    <details className="job-io" data-testid="job-io" open={open}>
      <summary
        onClick={(event) => {
          // The page owns `open`, so the browser's own toggle is cancelled and
          // re-made there — otherwise the DOM and the prop would disagree.
          event.preventDefault()
          onToggle()
        }}
      >
        Job inputs and outputs
      </summary>

      <div className="job-io-body">
        <div className="job-io-toolbar">
          <div className="segmented" role="tablist" aria-label="Side">
            {TABS.map((name) => (
              <button
                type="button"
                role="tab"
                className="tab"
                key={name}
                aria-selected={tab === name}
                aria-controls="job-io-panel"
                id={`job-io-tab-${name}`}
                onClick={() => onTab(name)}
              >
                {name}
              </button>
            ))}
          </div>

          {/* Every value on both tabs as the raw JSON its row holds (apps#450). */}
          <RawToggle />
        </div>

        <div className="pane-body" id="job-io-panel" role="tabpanel" aria-labelledby={`job-io-tab-${tab}`}>
          {tab === 'Input' && (
            <>
              {bindingNames.length > 0 && (
                <div className="pane-values">
                  {bindingNames.map((name) => {
                    const value = bindings[name]
                    const d = inferDecl(value)
                    return (
                      <ValueView
                        key={name}
                        label={name}
                        tag={kindTag(d)}
                        decl={d}
                        value={value}
                        origin={`matrix.${name}`}
                      />
                    )
                  })}
                </div>
              )}
              {needs.length === 0 ? (
                bindingNames.length === 0 && (
                  <p className="note">This job needs nothing — it starts with the run.</p>
                )
              ) : (
                <div className="pane-values">
                  {needs.map((need) => {
                    const upstream = runCtx.jobs?.[need]?.outputs ?? null
                    const names = Object.keys(def.jobs[need]?.outputs ?? {})
                    return (
                      <ValueView
                        key={need}
                        label={need}
                        tag={
                          names.length === 0
                            ? 'job · no outputs'
                            : `job · ${names.length} ${names.length === 1 ? 'output' : 'outputs'}`
                        }
                        decl={{ type: 'json' }}
                        value={upstream}
                        origin={`${def.jobs[need] ? jobLabel(def.jobs[need]!) : need} job output`}
                      />
                    )
                  })}
                </div>
              )}
            </>
          )}

          {tab === 'Output' &&
            (outputNames.length === 0 ? (
              <p className="note">This job declares no outputs of its own — its steps' outputs are on each step.</p>
            ) : (
              <div className="pane-values">
                {outputNames.map((name) => {
                  const collected = outputs?.[name] ?? null
                  // One item shows its own element of the collected list (spec §The job page).
                  const value =
                    index === undefined
                      ? collected
                      : Array.isArray(collected)
                        ? ((collected as unknown[])[index] ?? null)
                        : collected
                  const resolved = resolveOutput(def, { kind: 'job', job }, name)
                  const base = index === undefined ? resolved.decl : elementDecl(resolved.decl)
                  const d = withFileRefValue(base, value)
                  return (
                    <ValueView
                      key={name}
                      label={name}
                      tag={kindTag(d)}
                      decl={d}
                      value={value}
                      impl={impl}
                      images={outputImageMap(def, state, d, resolved.site)}
                      destination={destinationOf(def, job, name)}
                    />
                  )
                })}
              </div>
            ))}
        </div>
      </div>
    </details>
  )
}
