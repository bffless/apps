/**
 * The Summary's Annotations panel (08 §5, spec 2026-09-08 Task 9) — every
 * annotation the run produced, run-level ones first, then each step's, each
 * linking back to the step it came from so the panel is a way *into* the
 * graph rather than a dead end.
 *
 * A `<details>`, GitHub's own shape for annotations on a run summary: closed
 * by default (the common case is nothing worth dwelling on), except when the
 * run carries an error — the one severity worth greeting the reader with open.
 */
import { Link } from 'react-router-dom'
import { ANNOTATION_LEVELS } from '../../lib/annotations'
import { pluralize } from '../../lib/plural'
import type { Annotation } from '../../lib/runner/types'
import { stepPath } from '../../lib/runRoutes'

export interface AnnotationsPanelProps {
  annotations: Annotation[]
  base: string
  runId: string
}

/** "Annotations · 1 warning, 2 notices", loudest level first; "No annotations" when there are none. */
function summaryLine(annotations: Annotation[]): string {
  const counts = ANNOTATION_LEVELS.map((level) => ({
    level,
    count: annotations.filter((annotation) => annotation.level === level).length,
  })).filter((entry) => entry.count > 0)
  if (counts.length === 0) return 'No annotations'
  return `Annotations · ${counts.map(({ level, count }) => pluralize(count, level)).join(', ')}`
}

export function AnnotationsPanel({ annotations, base, runId }: AnnotationsPanelProps) {
  const hasError = annotations.some((annotation) => annotation.level === 'error')

  return (
    <details className="annotations-panel" data-testid="annotations" open={hasError}>
      <summary>{summaryLine(annotations)}</summary>
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
                  <Link className="link-button annotation-jump" to={stepPath(base, runId, from)}>
                    {from}
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </details>
  )
}
