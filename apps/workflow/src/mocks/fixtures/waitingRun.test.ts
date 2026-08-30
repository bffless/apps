/**
 * The parked-run fixture is only useful if the engine folds it into a run that
 * is still running and waiting on its form — the state the run page would show
 * for it, and the row Past runs' "waiting on" note reads (apps#473).
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { describe, expect, it } from 'vitest'
import { firstWaitingStep } from '../../lib/runner/graph'
import { replayRun } from '../../lib/runner/replay'
import { WAITING_RUN, WAITING_STEP_KEY } from './waitingRun'

describe('WAITING_RUN', () => {
  const def = toDefinition(WAITING_RUN.run.definition)
  const state = replayRun(WAITING_RUN.run, WAITING_RUN.steps, def)

  it('replays into a run still in flight, parked on its form', () => {
    expect(state.status).toBe('running')
    expect(state.finishedAt).toBeUndefined()
    expect(state.steps[WAITING_STEP_KEY].status).toBe('waiting')
    expect(state.steps[WAITING_STEP_KEY].kind).toBe('form')
    expect(firstWaitingStep(def, state)).toBe(WAITING_STEP_KEY)
  })

  it('has exactly one waiting row, and every other row terminal', () => {
    const waiting = WAITING_RUN.steps.filter((step) => step.status === 'waiting')
    expect(waiting.map((step) => step.key)).toEqual([WAITING_STEP_KEY])
    for (const step of WAITING_RUN.steps) {
      if (step.key === WAITING_STEP_KEY) continue
      expect(['succeeded', 'failed'], step.key).toContain(step.status)
    }
  })

  it('carries what `run.finished` would have written as not yet written', () => {
    expect(WAITING_RUN.run.finishedAt).toBeNull()
    expect(WAITING_RUN.run.outputs).toBeNull()
    expect(WAITING_RUN.run.annotationCounts).toBeUndefined()
    expect(WAITING_RUN.run.leaseOwner).toBeNull()
  })
})
