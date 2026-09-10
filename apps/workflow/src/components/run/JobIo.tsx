/**
 * "Job inputs" — what the job waited on, folded into a disclosure under the
 * job head (spec 2026-09-08, phase 3: GitHub keeps the job's envelope
 * collapsed and gives the page to the steps).
 *
 * Its `needs`, each upstream job's evaluated outputs as this job's expressions
 * see them (`needs.<job>.outputs`). On one *item* of a matrix job the item's
 * own bindings come first — `who: studio` is the most specific answer to "what
 * was this leg given", and it is stated nowhere else on the page.
 *
 * The job's **outputs** used to be the other side of a toggle here; since the
 * 2026-09-09 UX review they are their own section *below* the steps
 * (`JobOutput`), because a job's result comes after the work that produced it.
 * There is no Input/Output switch left to own. **Show raw** stays: it is a
 * preference over the values on screen, not a choice of which side to show.
 *
 * The disclosure is deliberately not a native uncontrolled `<details>`, and it
 * does not own its openness: `JobPage` holds it, next to the set of open step
 * rows, because a row click is a *navigation* — it rewrites `?step=` and drops
 * `?tab=` — and anything this component kept in its own `useState` would be
 * thrown away with it. (It was: keying the element on the URL's `tab` and
 * `index` remounted it on the first row click, snapping the disclosure shut.)
 * The summary's own click is intercepted and reported up as `onToggle`, which
 * is also what makes it behave identically in jsdom and in a browser.
 */
import { buildRunContexts } from '../../lib/runner/contexts'
import type { Definition, RunState } from '../../lib/runner/types'
import { jobLabel } from '../graph/geometry'
import { ExpandAll } from '../values/ExpandAll'
import { RawToggle } from '../values/RawToggle'
import { isBulky } from '../values/valueSummary'
import { ValueView } from '../values/ValueView'
import { ValuesOpenProvider, useValuesBulk } from '../values/valuesOpen'
import { inferDecl } from '../values/inferDecl'
import { kindTag } from '../values/valueMeta'

export interface JobIoProps {
  def: Definition
  state: RunState
  job: string
  /** One item of a matrix job: its own bindings on Input, its element of each collected output. */
  index?: number
  /** Open — an edge dot asked for this job's inputs, so they have to be showing. */
  open: boolean
  onToggle: () => void
}

export function JobIo({ def, state, job, index, open, onToggle }: JobIoProps) {
  const decl = def.jobs[job]

  // Evaluated the way `jobs.<job>.outputs` / `needs.<job>.outputs` read them.
  const runCtx = buildRunContexts(def, state) as { jobs?: Record<string, { outputs: Record<string, unknown> | null }> }
  const needs = decl?.needs ?? []
  const bindings = index === undefined ? {} : (state.expansions[job]?.items[index] ?? {})
  const bindingNames = Object.keys(bindings)
  const { bulk, toggle } = useValuesBulk()

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
        Job inputs
      </summary>

      <div className="job-io-body">
        {/* Every value on this side as the raw JSON its row holds (apps#450).
            Spec 08 names it here; the Input/Output toggle beside it went with
            the outputs, but this is a preference over the values, not a side. */}
        <div className="job-io-toolbar">
          <RawToggle />
        </div>
        <div className="pane-body">
          <ExpandAll
            count={
              bindingNames.filter((name) => isBulky(inferDecl(bindings[name]), bindings[name])).length +
              needs.filter((need) => isBulky({ type: 'json' }, runCtx.jobs?.[need]?.outputs ?? null)).length
            }
            unit="input"
            open={bulk.open}
            onToggle={toggle}
          />
          <ValuesOpenProvider value={bulk}>
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
                      collapsible
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
                      collapsible
                    />
                  )
                })}
              </div>
            )}
          </ValuesOpenProvider>
        </div>
      </div>
    </details>
  )
}
