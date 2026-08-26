/**
 * The `annotationCounts` rollup on the `run.finished` patch (Task 20).
 *
 * Past runs is a list of **run rows** — the endpoint returns no step rows — so
 * an honest annotations column needs the per-step counts rolled onto the run
 * row at the one moment the whole run is known: the event that finishes it.
 * This is that rollup, and nothing else in the write path recomputes it.
 *
 * `eventToWrites` is a pure mapper over the post-event state, so the state is
 * built here by hand: the point is which numbers land in the patch, not how
 * the reducer arrived at the annotations.
 */
import { describe, expect, it } from 'vitest'
import { eventToWrites } from './rows'
import type { RunRow } from './rows'
import type { Annotation, RunState, StepKey, StepState } from './types'

const RUN_ID = 'run_ROLLUP'

function step(key: StepKey, annotations: Annotation[]): StepState {
  const [job, index, stepId] = key.split('/')
  return {
    key,
    job,
    index: Number(index),
    stepId,
    kind: 'pipeline',
    status: 'succeeded',
    attempt: 1,
    annotations,
  }
}

/** A run shaped like the `hello` fixture's: one notice on a step, one warning on another. */
function stateWith(a: { run?: Annotation[]; steps?: StepState[] } = {}): RunState {
  const steps: Record<StepKey, StepState> = {}
  for (const s of a.steps ?? []) steps[s.key] = s
  return {
    runId: RUN_ID,
    impl: 'hello',
    workflow: 'hello',
    status: 'succeeded',
    headless: false,
    inputs: {},
    steps,
    expansions: {},
    annotations: a.run ?? [],
    startedAt: 0,
    finishedAt: 10,
  }
}

/** The single `runs` patch a `run.finished` event produces. */
function finishPatch(state: RunState): Partial<RunRow> {
  const writes = eventToWrites({ type: 'run.finished', status: 'succeeded', at: 10 }, { state })
  expect(writes).toHaveLength(1)
  const write = writes[0]
  if (write.table !== 'runs' || write.op !== 'patch') throw new Error('expected a runs patch')
  expect(write.id).toBe(RUN_ID)
  return write.patch
}

describe('eventToWrites — run.finished annotationCounts', () => {
  it("rolls up every step's annotations plus the run's own", () => {
    const patch = finishPatch(
      stateWith({
        steps: [
          step('greet/0/say', []),
          step('slow/0/start', [{ level: 'notice', message: 'Job job_hello_1 took 1234 ms' }]),
          step('flaky/0/after', [{ level: 'warning', message: 'boom failed with TEAPOT' }]),
        ],
      }),
    )

    expect(patch.annotationCounts).toEqual({ error: 0, warning: 1, notice: 1 })
  })

  it('counts the run-level annotations too', () => {
    const patch = finishPatch(
      stateWith({
        run: [
          { level: 'error', message: 'a write failed' },
          { level: 'notice', message: 'cancelled' },
        ],
        steps: [step('greet/0/say', [{ level: 'error', message: 'boom' }])],
      }),
    )

    expect(patch.annotationCounts).toEqual({ error: 2, warning: 0, notice: 1 })
  })

  it('is all zeroes for a run that annotated nothing — never absent', () => {
    const patch = finishPatch(stateWith({ steps: [step('greet/0/say', [])] }))

    expect(patch.annotationCounts).toEqual({ error: 0, warning: 0, notice: 0 })
  })

  it('leaves the rest of the finish patch alone', () => {
    const patch = finishPatch(stateWith())

    expect(patch.status).toBe('succeeded')
    expect(patch.finishedAt).toBe(10)
    expect(patch.leaseOwner).toBeNull()
    expect(patch.leaseUntil).toBeNull()
  })
})
