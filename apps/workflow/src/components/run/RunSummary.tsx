/**
 * The run's summary page (08 §4), the harness's answer to a GitHub job summary:
 * every step's `summary` concatenated in the order the scheduler ran them —
 * topological job order, then matrix item, then declaration order — each
 * rendered as the markdown it is (05: HTML is never interpreted).
 */
import { jobOrder } from '../../lib/runner/graph'
import type { Definition, RunState, StepState } from '../../lib/runner/types'
import { MarkdownView } from '../values/MarkdownView'

function summarised(def: Definition, state: RunState): StepState[] {
  return jobOrder(def).flatMap((job) => {
    const order = def.jobs[job]?.steps.map((step) => step.id) ?? []
    return Object.values(state.steps)
      .filter((step) => step.job === job && step.summary)
      .sort((a, b) => a.index - b.index || order.indexOf(a.stepId) - order.indexOf(b.stepId))
  })
}

export function RunSummary({ def, state }: { def: Definition; state: RunState }) {
  const steps = summarised(def, state)

  return (
    <section className="run-summary" data-testid="run-summary">
      <h4 className="section-title">Summary</h4>
      {steps.length === 0 ? (
        <p className="note">No step wrote a summary.</p>
      ) : (
        <div className="summary-entries">
          {steps.map((step) => (
            <article className="summary-entry" key={step.key}>
              <p className="summary-step">{step.key}</p>
              <MarkdownView value={step.summary!} />
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
