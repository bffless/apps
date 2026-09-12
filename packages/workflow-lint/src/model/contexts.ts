import type { Job } from './definition.js'
import type { Slot } from './slots.js'

/** Slots that belong to a step (vs job- or document-level). */
export const STEP_SLOTS = new Set<Slot['where']>([
  'step-if',
  'with',
  'body',
  'query',
  'poll',
  'poll-query',
  'poll-body',
  'retry-if',
  'step-output-value',
  'step-output-images',
  'summary',
  'annotation-if',
  'annotation-message',
  'headless-output',
  'auto-accept',
])

/** Where the most recent pipeline response is readable (01 contexts table). */
const RESPONSE_SLOTS = new Set<Slot['where']>([
  'poll',
  'poll-query',
  'poll-body',
  'retry-if',
  'step-output-value',
  'summary',
  'annotation-if',
  'annotation-message',
])

/** The two `on.manual.warnings` slots: read on the kickoff form, before a run exists. */
export const KICKOFF_SLOTS = new Set<Slot['where']>(['kickoff-warning-if', 'kickoff-warning-message'])

/**
 * The context roots legal in a slot, per the table in 01-workflow-yaml.md.
 * `inputs` and `impl` are available everywhere; `run` everywhere but a kickoff warning.
 */
export function allowedRoots(slot: Slot, job?: Job): Set<string> {
  // A kickoff warning (01) is evaluated against the form's current values:
  // there is no run yet, so not even `run` is there to read.
  if (KICKOFF_SLOTS.has(slot.where)) return new Set(['inputs', 'impl'])

  const roots = new Set(['inputs', 'run', 'impl'])

  if (slot.where === 'top-output') {
    roots.add('jobs')
    return roots
  }

  // Everything below is inside some job.
  roots.add('needs')

  if (slot.where === 'matrix') {
    // Matrix values are evaluated before fan-out: no steps/matrix/strategy yet.
    return roots
  }

  if (slot.where === 'job-if') {
    return roots
  }

  // job-output and all step slots can read steps; matrix jobs add matrix/strategy.
  roots.add('steps')
  if (job?.matrix) {
    roots.add('matrix')
    roots.add('strategy')
  }

  if (STEP_SLOTS.has(slot.where)) {
    roots.add('step')
    if (slot.stepUses === 'pipeline' && RESPONSE_SLOTS.has(slot.where)) {
      roots.add('response')
    }
    // error: a pipeline step's retry.if/annotations read its own last failure;
    // any step after the first can read the job's last failed step (01).
    if (
      slot.where === 'retry-if' ||
      slot.where === 'annotation-if' ||
      slot.where === 'annotation-message' ||
      (slot.stepIndex ?? 0) > 0
    ) {
      roots.add('error')
    }
  }

  return roots
}
