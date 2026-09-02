/**
 * Completing a waiting interactive step — the one submit path (spec 10, D19
 * extended from 07/D12): a person's click in `FormStepPane`, an island's
 * `workflow.submit` and an agent's `workflow.submitStep` must all be judged
 * by the same validator, so the branch on the step's kind lives here, once.
 *
 * A `form`'s values go through `completeFormStep` (its evaluated fields); an
 * `island`'s outputs through `completeIslandStep` (its declared output map).
 * Both return the `step.succeeded` event the reducer folds, and the middleware
 * does the rest — persistence, the island's bridge teardown on the terminal
 * event, the scheduler's next pass. Nothing here throws: every way the submit
 * can be wrong comes back as a keyed refusal, because two of the three callers
 * have no stack to show anybody.
 *
 * Whether this tab is *driving* the run is the caller's question, as it was
 * when the pane dispatched the event itself: the pane only renders a form on
 * the live path (`StepPane`'s gate), and the agent executor checks the slice's
 * mode before it gets here.
 */
import { completeFormStep } from '../lib/runner/adapters/form'
import { completeIslandStep } from '../lib/runner/adapters/island'
import type { StepKey } from '../lib/runner/types'
import type { AppThunk } from './index'
import { runEvent } from './runSlice'

export type SubmitResult = { ok: true } | { ok: false; errors: Record<string, string> }

export function submitStep(a: { key: StepKey; values: Record<string, unknown>; at?: number }): AppThunk<SubmitResult> {
  return (dispatch, getState) => {
    const { state, meta } = getState().run
    if (!state || !meta) return { ok: false, errors: { runId: 'This page has no run' } }
    const stepState = state.steps[a.key]
    if (!stepState) return { ok: false, errors: { step: 'No such step in this run' } }
    if (stepState.kind !== 'form' && stepState.kind !== 'island') {
      return { ok: false, errors: { step: `A ${stepState.kind} step cannot be submitted` } }
    }
    if (stepState.status !== 'waiting') {
      return { ok: false, errors: { step: `That step is not waiting (status: ${stepState.status})` } }
    }
    const step = meta.def.jobs[stepState.job]?.steps.find((candidate) => candidate.id === stepState.stepId)
    if (!step) return { ok: false, errors: { step: 'No such step in this definition' } }

    const common = {
      step,
      key: a.key,
      job: stepState.job,
      index: stepState.index,
      def: meta.def,
      state,
      at: a.at ?? Date.now(),
    }
    const result =
      stepState.kind === 'form'
        ? completeFormStep({ ...common, values: a.values })
        : completeIslandStep({ ...common, outputs: a.values })
    if (!result.ok) return result
    dispatch(runEvent(result.event))
    return { ok: true }
  }
}
