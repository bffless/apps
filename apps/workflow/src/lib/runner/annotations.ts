/**
 * Every annotation of a run, run-level and per step (08 §5, spec
 * 2026-09-08 Task 9): each step's own annotations stamped with the step key
 * they came from, so `AnnotationsPanel` can jump to it like any other. Pulled
 * out of `RunShell` so `AnnotationsPanel.test.tsx` can build its fixture the
 * same way the page does, rather than hand-stamping `stepKey` itself.
 */
import type { Annotation, RunState } from './types'

export function collectAnnotations(state: RunState): Annotation[] {
  return [
    ...state.annotations,
    ...Object.values(state.steps).flatMap((step) =>
      step.annotations.map((annotation) => ({ ...annotation, stepKey: step.key })),
    ),
  ]
}
