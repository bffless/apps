/**
 * The pure, event-sourced run reducer (01/09): folds a `RunEvent` onto a
 * `RunState`, producing a new state with structural sharing — untouched
 * subtrees (other steps, the annotations array, ...) keep their prior
 * object identity so callers can cheaply diff renders.
 *
 * Pure: no imports beyond ./types and ./transitions (spec 09, enforced by
 * eslint's lib/runner fence, and deliberately kept narrower here so the
 * reducer never grows a dependency on the expression engine or definition
 * loader — replay (Task 9) folds raw events through this module alone).
 */
import type { RunEvent, RunState, StepKey, StepState } from './types'
import { assertTransition, IllegalTransition } from './transitions'

export function initialRunState(a: {
  runId: string
  impl: string
  workflow: string
  inputs: Record<string, unknown>
  headless: boolean
  startedAt: number
}): RunState {
  return {
    runId: a.runId,
    impl: a.impl,
    workflow: a.workflow,
    status: 'running',
    headless: a.headless,
    inputs: a.inputs,
    steps: {},
    expansions: {},
    annotations: [],
    startedAt: a.startedAt,
  }
}

/** Look up a step or throw — a `RunEvent` referencing an unknown key is a bug (09: bugs throw). */
function getStep(state: RunState, key: StepKey): StepState {
  const step = state.steps[key]
  if (!step) throw new Error(`Unknown step: ${key}`)
  return step
}

/** Replace one step, sharing every other step and the rest of the state by reference. */
function withStep(state: RunState, key: StepKey, step: StepState): RunState {
  return { ...state, steps: { ...state.steps, [key]: step } }
}

/**
 * `step.queued`/`step.skipped` create a brand-new StepState — never legally
 * re-emitted for a key that already exists (retry re-queues via
 * `step.retrying`, not a second `step.queued`). A duplicate/stray event on
 * an existing key would otherwise silently reset an in-flight or terminal
 * step back to queued/skipped, wiping its outputs/error/response/timestamps.
 */
function assertNewStep(state: RunState, key: StepKey, eventType: string): void {
  if (state.steps[key]) {
    throw new IllegalTransition(`${key}: duplicate ${eventType} for existing step`)
  }
}

export function runReducer(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case 'run.started':
      return initialRunState({
        runId: event.runId,
        impl: event.impl,
        workflow: event.workflow,
        inputs: event.inputs,
        headless: event.headless,
        startedAt: event.at,
      })

    case 'job.expanded':
      return {
        ...state,
        expansions: {
          ...state.expansions,
          [event.job]: { total: event.total, items: event.items },
        },
      }

    case 'step.queued':
      assertNewStep(state, event.key, 'step.queued')
      return withStep(state, event.key, {
        key: event.key,
        job: event.job,
        index: event.index,
        stepId: event.stepId,
        kind: event.kind,
        status: 'queued',
        attempt: 1,
        annotations: [],
      })

    case 'step.skipped':
      assertNewStep(state, event.key, 'step.skipped')
      return withStep(state, event.key, {
        key: event.key,
        job: event.job,
        index: event.index,
        stepId: event.stepId,
        kind: event.kind,
        status: 'skipped', // terminal
        attempt: 1,
        annotations: [],
      })

    case 'step.started': {
      const step = getStep(state, event.key)
      assertTransition(step.status, 'running', event.key)
      return withStep(state, event.key, {
        ...step,
        status: 'running',
        inputs: event.inputs,
        startedAt: event.at,
      })
    }

    case 'step.polling': {
      const step = getStep(state, event.key)
      assertTransition(step.status, 'polling', event.key)
      return withStep(state, event.key, {
        ...step,
        status: 'polling',
        response: { ...step.response, initial: event.initial },
      })
    }

    case 'step.waiting': {
      const step = getStep(state, event.key)
      assertTransition(step.status, 'waiting', event.key)
      return withStep(state, event.key, { ...step, status: 'waiting' })
    }

    case 'step.retrying': {
      const step = getStep(state, event.key)
      assertTransition(step.status, 'queued', event.key)
      return withStep(state, event.key, {
        ...step,
        status: 'queued',
        attempt: step.attempt + 1,
        error: event.error, // kept for the pane
      })
    }

    case 'step.succeeded': {
      const step = getStep(state, event.key)
      assertTransition(step.status, 'succeeded', event.key)
      return withStep(state, event.key, {
        ...step,
        status: 'succeeded',
        outputs: event.outputs,
        response: event.response ?? step.response,
        summary: event.summary ?? step.summary,
        // Appended, never replaced (Decision 12): a step's declared
        // `annotations:` join whatever `step.annotated` already appended while
        // it was in flight — otherwise an island's `workflow.annotate` would
        // vanish at the moment its own `workflow.submit` lands.
        annotations: [...step.annotations, ...(event.annotations ?? [])],
        finishedAt: event.at,
      })
    }

    case 'step.failed': {
      const step = getStep(state, event.key)
      assertTransition(step.status, 'failed', event.key)
      return withStep(state, event.key, {
        ...step,
        status: 'failed',
        error: event.error,
        // Appended, never replaced (Decision 12) — see `step.succeeded` above.
        annotations: [...step.annotations, ...(event.annotations ?? [])],
        finishedAt: event.at,
      })
    }

    case 'step.cancelled': {
      const step = getStep(state, event.key)
      assertTransition(step.status, 'cancelled', event.key)
      return withStep(state, event.key, {
        ...step,
        status: 'cancelled', // terminal
        finishedAt: event.at,
      })
    }

    /**
     * An in-place update, not a transition (Decision 12): a step that is still
     * in flight reports progress. `STEP_TRANSITIONS` is a *status* graph and
     * this event changes no status, so the legality check is an explicit one
     * — annotating a queued step (nothing is running yet) or a terminal one
     * (its row is already the final record) is a bug, and bugs throw (09).
     */
    case 'step.annotated': {
      const step = getStep(state, event.key)
      if (step.status !== 'running' && step.status !== 'polling' && step.status !== 'waiting') {
        throw new IllegalTransition(
          `${event.key}: step.annotated is only legal while running|polling|waiting (was ${step.status})`,
        )
      }
      return withStep(state, event.key, {
        ...step,
        annotations: event.annotations
          ? [...step.annotations, ...event.annotations]
          : step.annotations,
        summary: event.summary ?? step.summary,
      })
    }

    case 'run.annotation':
      return { ...state, annotations: [...state.annotations, event.annotation] }

    case 'run.finished':
      return { ...state, status: event.status, outputs: event.outputs, finishedAt: event.at }

    default: {
      const exhaustive: never = event
      throw new Error(`Unknown run event: ${JSON.stringify(exhaustive)}`)
    }
  }
}
