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
import type { StepRow } from './rows'
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
    unattended: false,
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

// ---------------------------------------------------------------------------
// step.skipped — the outputs a headless skip stood in for (Task 12)
// ---------------------------------------------------------------------------

describe('eventToWrites — step.skipped', () => {
  const KEY: StepKey = 'confirm/0/review'

  /** The state after a skip of `KEY`, with whatever outputs the skip carried. */
  function skipped(outputs?: Record<string, unknown>): RunState {
    const state = stateWith()
    return {
      ...state,
      status: 'running',
      steps: {
        [KEY]: {
          key: KEY,
          job: 'confirm',
          index: 0,
          stepId: 'review',
          kind: 'form',
          status: 'skipped',
          attempt: 1,
          annotations: [],
          ...(outputs ? { outputs } : {}),
        },
      },
    }
  }

  const skipPatch = (state: RunState): Partial<StepRow> => {
    const writes = eventToWrites(
      { type: 'step.skipped', key: KEY, job: 'confirm', index: 0, stepId: 'review', kind: 'form', at: 9 },
      { state },
    )
    expect(writes).toHaveLength(1)
    const write = writes[0]
    if (write.table !== 'steps') throw new Error('expected a steps upsert')
    return write.patch
  }

  it('writes the outputs a headless skip stood in for', () => {
    expect(skipPatch(skipped({ approved: true }))).toMatchObject({
      status: 'skipped',
      finishedAt: 9,
      outputs: { approved: true },
    })
  })

  it('writes no outputs column for a scheduler skip', () => {
    const patch = skipPatch(skipped())
    expect(patch.status).toBe('skipped')
    expect('outputs' in patch).toBe(false)
  })
})

describe('eventToWrites — the script `log` tail (apps#527)', () => {
  const KEY: StepKey = 'make/0/poster'

  /** The post-event state of a script step, with whatever tail it holds. */
  function scripted(over: Partial<StepState>): RunState {
    const state = stateWith()
    return {
      ...state,
      status: 'running',
      steps: {
        [KEY]: {
          key: KEY,
          job: 'make',
          index: 0,
          stepId: 'poster',
          kind: 'script',
          status: 'succeeded',
          attempt: 1,
          annotations: [],
          ...over,
        },
      },
    }
  }

  const stepPatch = (event: RunEvent, state: RunState): Partial<StepRow> => {
    const writes = eventToWrites(event, { state })
    expect(writes).toHaveLength(1)
    const write = writes[0]
    if (write.table !== 'steps') throw new Error('expected a steps upsert')
    return write.patch
  }

  it('rides the terminal upserts, off the post-event state', () => {
    const log = ['frame 1', 'frame 2']
    expect(
      stepPatch(
        { type: 'step.succeeded', key: KEY, outputs: {}, at: 9 },
        scripted({ outputs: {}, log, finishedAt: 9 }),
      ).log,
    ).toEqual(log)
    expect(
      stepPatch(
        { type: 'step.failed', key: KEY, error: { code: 'SCRIPT', message: 'boom' }, at: 9 },
        scripted({ status: 'failed', error: { code: 'SCRIPT', message: 'boom' }, log, finishedAt: 9 }),
      ).log,
    ).toEqual(log)
    expect(
      stepPatch(
        { type: 'step.cancelled', key: KEY, at: 9 },
        scripted({ status: 'cancelled', log, finishedAt: 9 }),
      ).log,
    ).toEqual(log)
  })

  it('writes no column at all when the step holds no tail', () => {
    const patch = stepPatch(
      { type: 'step.succeeded', key: KEY, outputs: {}, at: 9 },
      scripted({ outputs: {}, finishedAt: 9 }),
    )
    expect('log' in patch).toBe(false)
  })

  it('clears the failed attempt\'s tail on step.retrying, like its annotations', () => {
    const patch = stepPatch(
      { type: 'step.retrying', key: KEY, error: { code: 'SCRIPT', message: 'boom' }, at: 9 },
      // The reducer already dropped `log` for the fresh attempt.
      scripted({ status: 'queued', attempt: 2, error: { code: 'SCRIPT', message: 'boom' } }),
    )
    expect(patch.log).toBeNull()
  })
})
