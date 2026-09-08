/**
 * What a step *declares*, as the expanded row's body on the workflow page
 * (spec 2026-09-08, §The workflow page): the same shape the run page's
 * `StepBody` shows for an attempt — inputs on top, what the step promises
 * under them — read off the workflow file instead of off a run.
 *
 * **Inputs** is the declared `with`, entry by entry, through the same
 * `ValueView` the evaluated inputs go through, with the same origin line
 * (`valueMeta`): before a run, the honest reading of `body` is the expression
 * itself and the upstream values it names. An expression is *not* the value it
 * will produce — `${{ needs.greet.outputs.lines }}` is a string here and a
 * `string[]` at run time — so it is declared as the string it is rather than
 * inferred into a promise the file has not made.
 *
 * **Outputs** is `declaredOutputs` — the linter's answer to "what does this
 * step promise", so a form's fields and a bare pipeline step's `response`
 * count — as the same `OUT name · type` lines the graph's job card draws.
 *
 * The raw block sits behind a disclosure at the bottom, closed: it is the
 * complete truth and the least readable form of it. It keeps the
 * `step-declaration` testid the graph's side panel used to carry, which on
 * this screen is finally honest — it is one step's declaration again, not a
 * whole job's.
 */
import type { KeyboardEvent } from 'react'
import type { Step } from '../../lib/runner/types'
import { ValueView } from '../values/ValueView'
import { inferDecl } from '../values/inferDecl'
import { kindTag, originOf } from '../values/valueMeta'
import { declaredOutputs } from '../graph/geometry'

/** A `${{ … }}` template: a promise about a value, not the value (02). */
function isExpression(value: unknown): boolean {
  return typeof value === 'string' && value.includes('${{')
}

export interface DeclaredStepBodyProps {
  /** The job the step is declared in — its expressions' origins are read against it. */
  job: string
  step: Step
  /** Esc inside the body collapses the row, the same as the run body's (Task 11). */
  onClose?: () => void
}

export function DeclaredStepBody({ job, step, onClose }: DeclaredStepBodyProps) {
  const inputs = Object.entries((step.raw?.with ?? {}) as Record<string, unknown>)
  const outputs = declaredOutputs(step)

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && onClose) {
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <div className="step-body declared-body" aria-label="Declaration" onKeyDown={onKeyDown}>
      <h4 className="section-title">Inputs</h4>
      {inputs.length === 0 ? (
        <p className="note">This step declares no inputs.</p>
      ) : (
        <div className="pane-values">
          {inputs.map(([name, value]) => {
            const decl = isExpression(value) ? { type: 'string' as const } : inferDecl(value)
            return (
              <ValueView
                key={name}
                label={name}
                tag={kindTag(decl)}
                decl={decl}
                value={value}
                origin={originOf(job, value)}
              />
            )
          })}
        </div>
      )}

      <h4 className="section-title">Outputs</h4>
      {outputs.length === 0 ? (
        <p className="note">This step declares no outputs.</p>
      ) : (
        <div className="step-outs">
          {outputs.map(([name, type]) => (
            <span className="step-output" key={name}>
              <span className="out-tag" aria-hidden="true">
                out
              </span>
              <span className="out-name">{name}</span>
              <span className="out-type">{type}</span>
            </span>
          ))}
        </div>
      )}

      <details className="declaration-details">
        <summary>Declaration</summary>
        <pre className="declaration" data-testid="step-declaration">
          {JSON.stringify(step.raw, null, 2)}
        </pre>
      </details>
    </div>
  )
}
