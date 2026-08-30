/**
 * `waitingSteps` (apps#473): the keys the list joined onto a run row, named
 * and ordered from the definition the row carries — nothing fetched.
 */
import { describe, expect, it } from 'vitest'
import { toRunRow } from './coerce'
import { waitingSteps } from './waitingOn'
import { FINISHED_RUN } from '../mocks/fixtures/finishedRun'
import { WAITING_RUN, WAITING_STEP_KEY } from '../mocks/fixtures/waitingRun'

const listed = (waitingOn: unknown, extra: Record<string, unknown> = {}) =>
  toRunRow({ ...WAITING_RUN.run, ...extra, waitingOn })

describe('waitingSteps', () => {
  it('is empty for a row the list did not join, and for one waiting on nothing', () => {
    expect(waitingSteps(toRunRow(FINISHED_RUN.run))).toEqual([])
    expect(waitingSteps(listed([]))).toEqual([])
  })

  it('labels a step as the run page does: its `name`, else its id', () => {
    // The hello form declares no `name`, so its id is the label…
    expect(waitingSteps(listed([WAITING_STEP_KEY]))).toEqual([{ key: WAITING_STEP_KEY, label: 'review' }])

    // …and a step that does declare one is called by it.
    const definition = structuredClone(WAITING_RUN.run.definition) as { jobs: Record<string, { steps: { id: string; name?: string }[] }> }
    definition.jobs.confirm.steps[0].name = 'Review the report'
    expect(waitingSteps(listed([WAITING_STEP_KEY], { definition }))).toEqual([
      { key: WAITING_STEP_KEY, label: 'Review the report' },
    ])
  })

  it('orders several by schedule — topo job order, declaration order, matrix index', () => {
    const keys = ['confirm/0/review', 'flaky/0/after', 'greet/1/say', 'flaky/0/boom', 'greet/0/say']
    expect(waitingSteps(listed(keys)).map((s) => s.key)).toEqual([
      'greet/0/say',
      'greet/1/say',
      'flaky/0/boom',
      'flaky/0/after',
      'confirm/0/review',
    ])
  })

  it('keeps a key the definition does not know, after the ones it does, named by its step id', () => {
    expect(waitingSteps(listed(['ghost/0/step', WAITING_STEP_KEY, 'not-a-key']))).toEqual([
      { key: WAITING_STEP_KEY, label: 'review' },
      { key: 'ghost/0/step', label: 'step' },
      { key: 'not-a-key', label: 'not-a-key' },
    ])
  })

  it('falls back to the YAML snapshot when the stored definition is unusable', () => {
    expect(waitingSteps(listed([WAITING_STEP_KEY], { definition: null }))).toEqual([
      { key: WAITING_STEP_KEY, label: 'review' },
    ])
  })
})
