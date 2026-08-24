/**
 * Cancel, Resume and Take-over (Task 19) against the real MSW mock backend —
 * same posture as `runnerMiddleware.test.ts`'s scenario 2 and
 * `test/helloHarness.ts`: only the clock is faked, everything else (the
 * hello pipelines, the run record, the lease) is the actual mock rule set.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { completeFormStep, formInitialValues } from '../lib/runner/adapters/form'
import type { Step } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { RunRow, StepRow } from '../lib/runner/rows'
import { db, nextId, stepRowKey } from '../mocks/db'
import { server } from '../mocks/server'
import {
  flush,
  hello,
  HELLO_YAML,
  pumpUntil,
  REVIEW_KEY,
  resetHelloHarness,
  startHelloAtConfirmWaiting,
  trackedHelloStore,
} from '../test/helloHarness'
import { cancelRun, openRun, takeOver } from './lifecycleActions'
import { getOwnerId, startRun } from './runnerActions'
import { runEvent } from './runSlice'

afterEach(() => {
  resetHelloHarness()
})

const SLOW_KEY = stepKey('slow', 0, 'start')

function stepOf(job: string, id: string): Step {
  const step = hello.jobs[job]?.steps.find((s) => s.id === id)
  if (!step) throw new Error(`no such step ${job}.${id}`)
  return step
}

/** Submit `confirm/0/review` with its own defaults (approved, the pre-filled report) — same as `RunPage.live.test.tsx`'s "Finish" click, but at the store level. */
function submitReview(store: ReturnType<typeof trackedHelloStore>['store']): void {
  const state = store.getState().run.state!
  const step = stepOf('confirm', 'review')
  const values = formInitialValues({ step, def: hello, state, job: 'confirm', index: 0 })
  const r = completeFormStep({ step, key: REVIEW_KEY, job: 'confirm', index: 0, def: hello, state, values })
  if (!r.ok) throw new Error(`submitReview: form rejected ${JSON.stringify(r.errors)}`)
  store.dispatch(runEvent(r.event))
}

// ---------------------------------------------------------------------------
// (a) Cancel mid-poll
// ---------------------------------------------------------------------------

describe('cancelRun', () => {
  it('cancels a run mid-poll: the step, the run, and a cancel notice — persisted as the run patch', async () => {
    const { store, advance } = trackedHelloStore()
    store.dispatch(
      startRun({
        impl: 'hello',
        workflow: 'hello',
        def: hello,
        yaml: HELLO_YAML,
        workflowName: 'Hello workflow',
        values: { greeting: 'Hello', names: ['world'], photo: null, shout: false },
      }),
    )

    await pumpUntil(advance, () => store.getState().run.state?.steps[SLOW_KEY]?.status === 'polling')

    const runId = store.getState().run.state!.runId
    await store.dispatch(cancelRun())
    await flush()

    const state = store.getState().run.state!
    expect(state.steps[SLOW_KEY]?.status).toBe('cancelled')
    expect(state.status).toBe('cancelled')
    expect(state.annotations).toEqual([
      expect.objectContaining({
        level: 'notice',
        message: 'Run cancelled — server-side pipeline jobs already enqueued keep running.',
      }),
    ])

    // The write-ahead persistence landed: the run row's *own* status is the
    // final applied patch, not merely one that was attempted.
    const row = db.runs.get(runId)
    expect(row?.status).toBe('cancelled')
    expect(row?.leaseOwner).toBeNull()
  })

  it('is a no-op once the run has already finished', async () => {
    const { store } = await startHelloAtConfirmWaiting()
    submitReview(store)
    await flush()
    expect(store.getState().run.state?.status).toBe('succeeded')

    await store.dispatch(cancelRun())
    expect(store.getState().run.state?.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// (b) Resume: a `polling` row skips the initial request
// ---------------------------------------------------------------------------

describe('openRun — resume', () => {
  it('resumes a polling row with no re-POST, one poll tick, and finishes the run after the form', async () => {
    const runId = 'run_resume_b'
    const GREET0 = stepKey('greet', 0, 'say')
    const GREET1 = stepKey('greet', 1, 'say')
    const BOOM = stepKey('flaky', 0, 'boom')
    const AFTER = stepKey('flaky', 0, 'after')

    const run: RunRow = {
      runId,
      impl: 'hello',
      workflow: 'hello',
      workflowName: 'Hello workflow',
      definition: hello.raw,
      yaml: HELLO_YAML,
      inputs: { greeting: 'Hello', names: ['world', 'studio'], photo: null, shout: false },
      status: 'running',
      headless: false,
      startedAt: 1_000,
      finishedAt: null,
      leaseOwner: null,
      leaseUntil: null,
      outputs: null,
      annotations: [],
    }

    const steps: StepRow[] = [
      {
        runId, key: GREET0, job: 'greet', index: 0, step: 'say', kind: 'pipeline',
        status: 'succeeded', attempt: 1, outputs: { line: 'Hello, world!' }, startedAt: 1_000, finishedAt: 1_001,
      },
      {
        runId, key: GREET1, job: 'greet', index: 1, step: 'say', kind: 'pipeline',
        status: 'succeeded', attempt: 1, outputs: { line: 'Hello, studio!' }, startedAt: 1_000, finishedAt: 1_001,
      },
      {
        runId, key: BOOM, job: 'flaky', index: 0, step: 'boom', kind: 'pipeline',
        status: 'failed', attempt: 1, error: { code: 'TEAPOT', message: 'fails on purpose', status: 418 },
        startedAt: 1_001, finishedAt: 1_002,
      },
      {
        runId, key: AFTER, job: 'flaky', index: 0, step: 'after', kind: 'pipeline',
        status: 'succeeded', attempt: 1, outputs: { note: 'boom failed with TEAPOT' }, startedAt: 1_002, finishedAt: 1_003,
      },
      {
        runId, key: SLOW_KEY, job: 'slow', index: 0, step: 'start', kind: 'pipeline',
        status: 'polling', attempt: 1,
        inputs: {
          path: 'slow',
          body: { lines: ['Hello, world!', 'Hello, studio!'], photo: null, outPrefix: `workflows/hello/hello/runs/${runId}/slow/0/start` },
        },
        response: { initial: { jobId: 'job_seed' } },
        startedAt: 1_003,
      },
    ]

    db.runs.set(runId, { ...run, _id: nextId() })
    for (const step of steps) db.steps.set(stepRowKey(runId, step.key), { ...step, _id: nextId() })
    // The next poll (`polls` increments to 2, `< 2` fails) answers `done` —
    // exactly one tick needed, no retry/backoff wait.
    db.helloJobs.set('job_seed', {
      polls: 1,
      result: { markdown: '# resumed report', posterPath: null, ms: 42 },
    })

    const calls: { method: string; path: string }[] = []
    const onRequestStart = ({ request }: { request: Request }) => {
      calls.push({ method: request.method, path: new URL(request.url).pathname })
    }
    server.events.on('request:start', onRequestStart)

    const { store, advance } = trackedHelloStore()
    try {
      await store.dispatch(openRun({ runId, run, steps }))

      expect(store.getState().run.mode).toBe('live')
      expect(store.getState().run.state?.steps[SLOW_KEY]?.status).toBe('polling')

      await pumpUntil(advance, () => store.getState().run.state?.steps[SLOW_KEY]?.status === 'succeeded')

      const slowCalls = calls.filter((c) => c.path === '/api/hello/slow')
      const jobCalls = calls.filter((c) => c.path === '/api/hello/job')
      expect(slowCalls).toEqual([]) // never re-POSTed
      expect(jobCalls).toEqual([{ method: 'GET', path: '/api/hello/job' }]) // exactly one tick

      const slow = store.getState().run.state!.steps[SLOW_KEY]!
      expect(slow.outputs).toEqual({ report: '# resumed report', poster: null })

      await pumpUntil(advance, () => store.getState().run.state?.steps[REVIEW_KEY]?.status === 'waiting')
      submitReview(store)
      await flush()

      expect(store.getState().run.state?.status).toBe('succeeded')
    } finally {
      server.events.removeListener('request:start', onRequestStart)
    }
  })
})

// ---------------------------------------------------------------------------
// (c) Lease held → readonly; take-over flips live and the row's own
// ---------------------------------------------------------------------------

describe('openRun / takeOver — lease contention', () => {
  it('opens readonly while another owner holds the lease, then take-over adopts live and the row records our ownership', async () => {
    const runId = 'run_lease_c'
    const run: RunRow = {
      runId,
      impl: 'hello',
      workflow: 'hello',
      workflowName: 'Hello workflow',
      definition: hello.raw,
      yaml: HELLO_YAML,
      inputs: { greeting: 'Hello', names: ['world'], photo: null, shout: false },
      status: 'running',
      headless: false,
      startedAt: 1_000,
      finishedAt: null,
      leaseOwner: 'tab_other',
      leaseUntil: Date.now() + 60_000,
      outputs: null,
      annotations: [],
    }
    db.runs.set(runId, { ...run, _id: nextId() })

    const { store } = trackedHelloStore()

    await store.dispatch(openRun({ runId, run, steps: [] }))
    expect(store.getState().run.mode).toBe('readonly')
    expect(db.runs.get(runId)?.leaseOwner).toBe('tab_other')

    await store.dispatch(takeOver({ runId, run, steps: [] }))
    expect(store.getState().run.mode).toBe('live')
    expect(db.runs.get(runId)?.leaseOwner).toBe(getOwnerId())
  })
})
