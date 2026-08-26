/**
 * Every annotation a run produced, in one list (08 §5) — run-level ones first,
 * then each step's, each linking back to the step it came from so the list is a
 * way *into* the graph rather than a dead end.
 *
 * The jump is a button, not a link: the selection is view state (09), not a
 * route, so there is no URL to give it.
 */
import type { Annotation, StepKey } from '../lib/runner/types'

export interface AnnotationListProps {
  annotations: Annotation[]
  onJump: (key: StepKey) => void
}

export function AnnotationList({ annotations, onJump }: AnnotationListProps) {
  return (
    <section className="annotations-section" data-testid="annotations">
      <h4 className="section-title">Annotations</h4>
      {annotations.length === 0 ? (
        <p className="note">This run produced no annotations.</p>
      ) : (
        <ul className="annotations">
          {annotations.map((annotation, i) => {
            const from = annotation.stepKey
            return (
              <li className="annotation" key={`${from ?? ''}-${i}`} data-level={annotation.level}>
                <span className="badge" data-severity={annotation.level}>
                  {annotation.level}
                </span>
                {annotation.title && <span className="annotation-title">{annotation.title}</span>}
                <span className="annotation-message">{annotation.message}</span>
                {from && (
                  <button
                    type="button"
                    className="link-button annotation-jump"
                    onClick={() => onJump(from)}
                  >
                    {from}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
