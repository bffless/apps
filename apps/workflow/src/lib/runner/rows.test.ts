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
import type { Annotation, RunEvent, RunState, StepKey, StepState } from './types'

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

/** The single `runs` patch one run-level event produces. */
function runPatch(event: RunEvent, state: RunState): Partial<RunRow> {
  const writes = eventToWrites(event, { state })
  expect(writes).toHaveLength(1)
  const write = writes[0]
  if (write.table !== 'runs' || write.op !== 'patch') throw new Error('expected a runs patch')
  expect(write.id).toBe(RUN_ID)
  return write.patch
}

const finishPatch = (state: RunState): Partial<RunRow> =>
  runPatch({ type: 'run.finished', status: 'succeeded', at: 10 }, state)

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

/**
 * P6: `run.finished` is **not** the last word on a run's annotations. The
 * middleware finishes the run first — that is what stops `nextActions`
 * proposing a second finish — and only then dispatches one `run.annotation`
 * per output declaration that failed to evaluate. So the rollup rides on that
 * patch too, or Past runs shows `0 0 0` for a run whose own page lists a
 * warning.
 */
describe('eventToWrites — run.annotation annotationCounts', () => {
  const annotation: Annotation = {
    level: 'warning',
    message: 'output "report" failed to evaluate: no such step',
  }

  it('re-rolls the counts on the same patch that appends the annotation', () => {
    // The state the middleware's `finish` case leaves behind: finished with
    // nothing annotated, then one late warning folded in.
    const finished = stateWith({ steps: [step('greet/0/say', [])] })
    expect(finishPatch(finished).annotationCounts).toEqual({ error: 0, warning: 0, notice: 0 })

    const after = { ...finished, annotations: [annotation] }
    const patch = runPatch({ type: 'run.annotation', annotation, at: 11 }, after)

    expect(patch.annotations).toEqual([annotation])
    expect(patch.annotationCounts).toEqual({ error: 0, warning: 1, notice: 0 })
  })

  it("counts the steps' annotations too, not only the run's own", () => {
    const after = stateWith({
      run: [annotation],
      steps: [step('slow/0/start', [{ level: 'notice', message: 'took a while' }])],
    })

    expect(runPatch({ type: 'run.annotation', annotation, at: 11 }, after).annotationCounts).toEqual(
      { error: 0, warning: 1, notice: 1 },
    )
  })
})
