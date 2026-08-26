/**
 * Cancel, Resume and Take-over (Task 19) against the real MSW mock backend —
 * same posture as `runnerMiddleware.test.ts`'s scenario 2 and
 * `test/helloHarness.ts`: only the clock is faked, everything else (the
 * hello pipelines, the run record, the lease) is the actual mock rule set.
 */
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { fileUrl } from '../lib/coerce'
import { httpJson } from '../lib/http'
import { completeFormStep, formInitialValues } from '../lib/runner/adapters/form'
import type { Step } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { RunStore } from '../lib/runStore'
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
  virtualClock,
} from '../test/helloHarness'
import { makeStore } from './index'
import { LeaseTransportError, cancelRun, openRun, takeOver } from './lifecycleActions'
import { getOwnerId, startRun } from './runnerActions'
import { createRegisterFile } from './runnerMiddleware'
import type { RunnerDeps } from './runnerMiddleware'
import { runClosed, runEvent } from './runSlice'
import { workflowApi } from './workflowApi'

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
  const r = completeFormStep({
    step,
    key: REVIEW_KEY,
    job: 'confirm',
    index: 0,
    def: hello,
    state,
    values,
    at: Date.now(),
  })
  if (!r.ok) throw new Error(`submitReview: form rejected ${JSON.stringify(r.errors)}`)
  store.dispatch(runEvent(r.event))
}

/** A run row + a `slow/0/start` row already `polling`, as replay would rebuild it (scenario b/1/2's shared fixture). `db.helloJobs` is seeded separately per test — how many ticks it takes to answer `done` is what each test is actually varying. */
function resumableRunAndSteps(runId: string): { run: RunRow; steps: StepRow[] } {
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

  return { run, steps }
}

function seedResumableRun(runId: string): { run: RunRow; steps: StepRow[] } {
  const { run, steps } = resumableRunAndSteps(runId)
  db.runs.set(runId, { ...run, _id: nextId() })
  for (const step of steps) db.steps.set(stepRowKey(runId, step.key), { ...step, _id: nextId() })
  return { run, steps }
}

type Recorded =
  | { op: 'create'; row: RunRow }
  | { op: 'patch'; id: string; patch: Partial<RunRow> }
  | { op: 'upsert'; runId: string; key: string; patch: Partial<StepRow> }

/** A recording `RunStore` — same shape as `runnerMiddleware.test.ts`'s own `fakeRunStore` — so a test can assert write *order*, not just a table's final row. */
function recordingRunStore(): { store: RunStore; writes: Recorded[] } {
  const writes: Recorded[] = []
  const store: RunStore = {
    async createRun(row) {
      writes.push({ op: 'create', row })
    },
    async patchRun(id, patch) {
      writes.push({ op: 'patch', id, patch })
    },
    async upsertStep(runId, key, patch) {
      writes.push({ op: 'upsert', runId, key, patch })
    },
    async lease() {
      return { ok: true, leaseUntil: Date.now() + 60_000 }
    },
  }
  return { store, writes }
}

/** Same posture as `trackedHelloStore()` (real `httpJson` against MSW for the hello pipelines, only the clock faked) but with a *recording* `RunStore` standing in for persistence, so write order is assertable. */
function trackedHelloStoreWithWrites(): {
  store: ReturnType<typeof makeStore>
  advance: (ms: number) => Promise<void>
  writes: Recorded[]
} {
  const { clock, advance } = virtualClock()
  const { store: runStore, writes } = recordingRunStore()
  const deps: RunnerDeps = { http: httpJson, clock, runStore, registerFile: createRegisterFile(httpJson) }
  return { store: makeStore(deps), advance, writes }
}

// ---------------------------------------------------------------------------
// (a) Cancel mid-poll
// ---------------------------------------------------------------------------

describe('cancelRun', () => {
  it('cancels a run mid-poll: the step, the run, a cancel notice, and the LAST recorded write is the cancelled run patch', async () => {
    const { store, advance, writes } = trackedHelloStoreWithWrites()
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

    // Write order (fix round 1, finding 3): the aborted `slow/0/start`
    // adapter's own `cancel()` still fires on a later microtask, after
    // `abortAll()` — without `scopedDispatch` dropping a stale emit once the
    // run is no longer `running`, this landed as a spurious extra step
    // upsert *after* the run's own final patch, so "the recorded writes end
    // with the run patch {status: 'cancelled'}" was false even though the
    // row's own final DB state (checked below too) still looked right.
    const last = writes[writes.length - 1]
    expect(last).toEqual({
      op: 'patch',
      id: runId,
      patch: expect.objectContaining({ status: 'cancelled', leaseOwner: null, leaseUntil: null }),
    })

    store.dispatch(runClosed())
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
    const { run, steps } = seedResumableRun(runId)
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

// ---------------------------------------------------------------------------
// (fix round 1, finding 1) Double-adopt of the same run must not wedge it
// ---------------------------------------------------------------------------

describe('openRun — double adoption of the same run', () => {
  it('a second adoption before the first settles supersedes it cleanly, and the run still completes', async () => {
    const runId = 'run_double_adopt'
    const { run, steps } = seedResumableRun(runId)
    // `polls: 0` — the first RESUMED tick answers `pending` (`polls` becomes
    // 1, `< 2`), so `slow/0/start`'s poll genuinely parks in `clock.sleep`
    // (the virtual clock never advances on its own) rather than settling in
    // the same microtask window the first `openRun` resolves in. That parked
    // window is exactly where the second adoption has to land to reproduce
    // the race: attempt #1 gets aborted mid-poll, and its own `cancel()`
    // must not land a stale `step.cancelled` on attempt #2's identical key.
    db.helloJobs.set('job_seed', {
      polls: 0,
      result: { markdown: '# resumed report', posterPath: null, ms: 42 },
    })

    const { store, advance } = trackedHelloStore()

    await store.dispatch(openRun({ runId, run, steps })) // adoption #1
    expect(store.getState().run.mode).toBe('live')
    // Let the relaunched poll's first tick land and its `sleep` register,
    // without moving the virtual clock yet (same posture as
    // `runnerMiddleware.test.ts`'s heartbeat scenario: settle real
    // microtasks before the clock advances at all).
    await flush()
    expect(store.getState().run.state?.steps[SLOW_KEY]?.status).toBe('polling')

    await store.dispatch(openRun({ runId, run, steps })) // adoption #2, same run
    expect(store.getState().run.mode).toBe('live')

    // Drive adoption #2's own relaunch through to completion. If the stale
    // emit from adoption #1 had landed, this throws `IllegalTransition`
    // (cancelled -> succeeded is not a legal transition) out of a
    // fire-and-forget async chain — an unhandled rejection that fails the
    // test — instead of the run finishing normally.
    await pumpUntil(advance, () => store.getState().run.state?.steps[SLOW_KEY]?.status === 'succeeded')
    await pumpUntil(advance, () => store.getState().run.state?.steps[REVIEW_KEY]?.status === 'waiting')
    submitReview(store)
    await flush()

    expect(store.getState().run.state?.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// (fix round 1, finding 2) A lost adoption of a different run must not
// disturb the run this tab is actually driving
// ---------------------------------------------------------------------------

describe('openRun — a lost adoption of a different run', () => {
  it('does not disturb the run this tab is actually driving', async () => {
    const { store, runId: runIdA } = await startHelloAtConfirmWaiting()
    // Run A is live in this tab, waiting on its form.

    const runIdB = 'run_lost_takeover_b'
    const runB: RunRow = {
      runId: runIdB,
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
    db.runs.set(runIdB, { ...runB, _id: nextId() })

    // Lease held elsewhere → the readonly fallback in `adopt()` — must not
    // touch A: neither the slice (still A, still `live`) nor the middleware
    // driving it (proven below by A finishing normally).
    await store.dispatch(openRun({ runId: runIdB, run: runB, steps: [] }))

    expect(store.getState().run.mode).toBe('live')
    expect(store.getState().run.state?.runId).toBe(runIdA)

    submitReview(store)
    await flush()

    expect(store.getState().run.state?.status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// (fix round 3, finding 3) A failed lease *request* is not a denial: it must
// not leak as an unhandled rejection, and the slice must stay untouched
// rather than get silently misread as "still held elsewhere."
// ---------------------------------------------------------------------------

describe('openRun — a failed lease request (transport failure)', () => {
  it('rejects with LeaseTransportError instead of a bare error, and never dispatches runReplaced', async () => {
    const runId = 'run_lease_transport_fail'
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
      leaseOwner: null,
      leaseUntil: null,
      outputs: null,
      annotations: [],
    }
    db.runs.set(runId, { ...run, _id: nextId() })

    // A 500 from the lease rule (`gate.fn.js`'s real-world equivalent of a
    // 502/network blip) — `runStore.lease` (runStore.ts's `post()`) throws on
    // any non-2xx, same as a genuine network failure would.
    server.use(
      http.post('/api/workflow/run/lease', () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    )

    const { store } = trackedHelloStore()

    await expect(store.dispatch(openRun({ runId, run, steps: [] }))).rejects.toThrow(LeaseTransportError)

    // Neither the live-adopt path nor the readonly fallback ran — the slice
    // is exactly as untouched as it was before the attempt.
    expect(store.getState().run.mode).toBeNull()
    expect(store.getState().run.state).toBeNull()

    // The lease rule was never reached successfully, so nothing changed
    // server-side either.
    expect(db.runs.get(runId)?.leaseOwner).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// (d) Task 13: resuming a run whose recorded output was offloaded to a file
// ---------------------------------------------------------------------------

const GREET0_KEY = stepKey('greet', 0, 'say')

describe('openRun — a resumed run whose succeeded step had a {"$file"} output', () => {
  it('evaluates the downstream expression against the hydrated value, not the pointer', async () => {
    const runId = 'run_resume_payload'
    seedResumableRun(runId)

    // `greet/0/say`'s `line` was over the persistence budget, so the row
    // carries a pointer. `jobs.greet.outputs.lines` collects that output and
    // the run's own `lines` output reads it — so if hydration did not happen,
    // the run finishes with a `{ $file }` object in its outputs.
    const path = `workflows/hello/hello/runs/${runId}/greet/0/say/line.json`
    const bytes = new TextEncoder().encode(JSON.stringify('Hello, world!'))
    db.files.set(path, { bytes, contentType: 'application/json' })
    const rowKey = stepRowKey(runId, GREET0_KEY)
    const row = db.steps.get(rowKey)!
    db.steps.set(rowKey, {
      ...row,
      outputs: {
        line: {
          $file: {
            path,
            name: 'line.json',
            contentType: 'application/json',
            size: bytes.byteLength,
            url: fileUrl(path),
          },
        },
      },
    })

    db.helloJobs.set('job_seed', {
      polls: 1,
      result: { markdown: '# resumed report', posterPath: null, ms: 42 },
    })

    const { store, advance } = trackedHelloStore()

    // The read path is the only place hydration happens — `openRun` is handed
    // whatever `getRun` produced, exactly as `RunPage.tsx` hands it over.
    const read = await store.dispatch(workflowApi.endpoints.getRun.initiate(runId))
    const record = read.data!
    expect(record.steps.find((s) => s.key === GREET0_KEY)?.outputs).toEqual({ line: 'Hello, world!' })

    await store.dispatch(openRun({ runId, run: record.run!, steps: record.steps }))
    await pumpUntil(advance, () => store.getState().run.state?.steps[REVIEW_KEY]?.status === 'waiting')
    submitReview(store)
    await flush()

    const state = store.getState().run.state!
    expect(state.status).toBe('succeeded')
    expect(state.outputs?.lines).toEqual(['Hello, world!', 'Hello, studio!'])
  })
})

// ---------------------------------------------------------------------------
// (e) Task 13 (M1 minor): a `polling` row whose recorded initial was truncated
// ---------------------------------------------------------------------------

describe('openRun — a polling row whose recorded initial was truncated', () => {
  it('re-requests the step from scratch exactly once and annotates the run', async () => {
    const runId = 'run_resume_truncated'
    const { run, steps } = resumableRunAndSteps(runId)
    const slow = steps.find((s) => s.key === SLOW_KEY)!
    // What `trimResponse` leaves behind when the initial response blew the
    // 256 KB budget — the `jobId` the poll's `query` reads is simply gone.
    slow.response = { initial: { note: 'truncated', size: 999_999 }, truncated: true }
    db.runs.set(runId, { ...run, _id: nextId() })
    for (const step of steps) db.steps.set(stepRowKey(runId, step.key), { ...step, _id: nextId() })

    // The hello service answers one BUSY per distinct body (R7); pre-marking
    // this one keeps the assertion about resume rather than about retry.
    db.helloBusy.add(JSON.stringify((slow.inputs as { body: unknown }).body))

    const calls: string[] = []
    const onRequestStart = ({ request }: { request: Request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
    }
    server.events.on('request:start', onRequestStart)

    const { store, advance } = trackedHelloStore()
    try {
      await store.dispatch(openRun({ runId, run, steps }))
      await pumpUntil(advance, () => store.getState().run.state?.steps[SLOW_KEY]?.status === 'succeeded')

      expect(calls.filter((c) => c === 'POST /api/hello/slow')).toHaveLength(1)
      expect(store.getState().run.state!.annotations).toContainEqual(
        expect.objectContaining({
          level: 'notice',
          // Review minor 3: stamped with the step, so `AnnotationList` can
          // offer the same "from <step>" jump every other step annotation has.
          stepKey: SLOW_KEY,
          message: `step ${SLOW_KEY} resumed from scratch — its initial response was truncated in the record`,
        }),
      )

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
// (f) Task 13 (M1 minor): cancelling a run that was just resumed
// ---------------------------------------------------------------------------

describe('cancelRun after a resume', () => {
  it('cancels every relaunched step, finishes the run, and lands no write after the run patch', async () => {
    const runId = 'run_cancel_after_resume'
    const BOOM = stepKey('flaky', 0, 'boom')
    const { run, steps } = resumableRunAndSteps(runId)
    // `flaky/0/boom` was mid-request when the driving tab went away (so
    // `flaky/0/after` never happened) — a `running` pipeline row alongside
    // the `polling` one, both relaunched by the resume listener.
    const rows: StepRow[] = steps
      .filter((s) => s.key !== stepKey('flaky', 0, 'after'))
      .map((s) =>
        s.key === BOOM
          ? {
              ...s,
              status: 'running' as const,
              error: null,
              finishedAt: null,
              inputs: { path: 'fail', body: { code: 'TEAPOT' } },
            }
          : s,
      )
    db.runs.set(runId, { ...run, _id: nextId() })
    for (const step of rows) db.steps.set(stepRowKey(runId, step.key), { ...step, _id: nextId() })

    // Both relaunches stay genuinely in flight: `fail` never answers, and the
    // resumed poll's first tick is `pending` so it parks in `clock.sleep`
    // (the virtual clock is never advanced before the cancel).
    server.use(http.post('/api/hello/fail', () => new Promise<never>(() => {})))
    db.helloJobs.set('job_seed', {
      polls: 0,
      result: { markdown: '# never read', posterPath: null, ms: 1 },
    })

    const { store, advance, writes } = trackedHelloStoreWithWrites()

    await store.dispatch(openRun({ runId, run, steps: rows }))
    expect(store.getState().run.mode).toBe('live')
    await flush()
    expect(store.getState().run.state?.steps[BOOM]?.status).toBe('running')
    expect(store.getState().run.state?.steps[SLOW_KEY]?.status).toBe('polling')

    await store.dispatch(cancelRun())
    await flush()

    const state = store.getState().run.state!
    expect(state.steps[BOOM]?.status).toBe('cancelled')
    expect(state.steps[SLOW_KEY]?.status).toBe('cancelled')
    expect(state.status).toBe('cancelled')

    expect(writes[writes.length - 1]).toEqual({
      op: 'patch',
      id: runId,
      patch: expect.objectContaining({ status: 'cancelled', leaseOwner: null, leaseUntil: null }),
    })

    // Nothing the aborted relaunches emit afterwards may reach the store —
    // the write count is stable once every pending timer and promise settles.
    const settled = writes.length
    await flush(20)
    await advance(60_000)
    await flush(20)
    expect(writes.length).toBe(settled)

    store.dispatch(runClosed())
  })
})

// ---------------------------------------------------------------------------
// (g) Review, Important: a payload that could not be loaded must not become a
// value a resumed run computes with
// ---------------------------------------------------------------------------

describe('openRun — a resumed run whose recorded output could not be loaded', () => {
  it('refuses to drive the run: nothing relaunched, an error annotation on the record, the run left running', async () => {
    const runId = 'run_resume_unreadable'
    seedResumableRun(runId)

    const path = `workflows/hello/hello/runs/${runId}/greet/0/say/line.json`
    const bytes = new TextEncoder().encode(JSON.stringify('Hello, world!'))
    db.files.set(path, { bytes, contentType: 'application/json' })
    const rowKey = stepRowKey(runId, GREET0_KEY)
    const row = db.steps.get(rowKey)!
    db.steps.set(rowKey, {
      ...row,
      outputs: {
        line: {
          $file: {
            path,
            name: 'line.json',
            contentType: 'application/json',
            size: bytes.byteLength,
            url: fileUrl(path),
          },
        },
      },
    })

    // The bucket is unreachable, so `getRun` hands back the sentinel rather
    // than the value — and `jobs.greet.outputs.lines` would otherwise collect
    // it straight into the run's own outputs.
    server.use(http.get('/api/uploads/*', () => new HttpResponse(null, { status: 500 })))

    const calls: string[] = []
    const onRequestStart = ({ request }: { request: Request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
    }
    server.events.on('request:start', onRequestStart)

    const { store } = trackedHelloStore()
    try {
      const read = await store.dispatch(workflowApi.endpoints.getRun.initiate(runId))
      const record = read.data!
      calls.length = 0

      await store.dispatch(openRun({ runId, run: record.run!, steps: record.steps }))
      await flush()

      // `slow/0/start` would have resumed its poll immediately; nothing did.
      expect(calls.filter((c) => c.includes('/api/hello/'))).toEqual([])

      const state = store.getState().run.state!
      expect(state.status).toBe('running')
      expect(state.steps[SLOW_KEY]?.status).toBe('polling')
      expect(state.annotations).toContainEqual(
        expect.objectContaining({
          level: 'error',
          stepKey: GREET0_KEY,
          message: `step ${GREET0_KEY}: output line could not be loaded (the payload request answered 500) — resume refused; Retry re-reads the run`,
        }),
      )
      expect(store.getState().run.paused).toBeTruthy()

      // The refusal is on the record, not just in this tab — and the run is
      // still `running`, so it stays adoptable once the lease lapses.
      expect(db.runs.get(runId)?.annotations).toContainEqual(
        expect.objectContaining({ level: 'error', stepKey: GREET0_KEY }),
      )
      expect(db.runs.get(runId)?.status).toBe('running')
    } finally {
      server.events.removeListener('request:start', onRequestStart)
    }
  })
})

// ---------------------------------------------------------------------------
// (h) Review minor 5: a `polling` row that never recorded an initial response
// ---------------------------------------------------------------------------

describe('openRun — a polling row with no recorded initial response', () => {
  it('takes the same from-scratch path as a truncated one, and says which it was', async () => {
    const runId = 'run_resume_no_initial'
    const { run, steps } = resumableRunAndSteps(runId)
    const slow = steps.find((s) => s.key === SLOW_KEY)!
    // The row says `polling` but carries no `response` at all — a half-written
    // row (08 degraded states). Polling it would read `response.jobId` off
    // `undefined`.
    delete slow.response
    db.runs.set(runId, { ...run, _id: nextId() })
    for (const step of steps) db.steps.set(stepRowKey(runId, step.key), { ...step, _id: nextId() })

    db.helloBusy.add(JSON.stringify((slow.inputs as { body: unknown }).body))

    const calls: string[] = []
    const onRequestStart = ({ request }: { request: Request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
    }
    server.events.on('request:start', onRequestStart)

    const { store, advance } = trackedHelloStore()
    try {
      await store.dispatch(openRun({ runId, run, steps }))
      await pumpUntil(advance, () => store.getState().run.state?.steps[SLOW_KEY]?.status === 'succeeded')

      expect(calls.filter((c) => c === 'POST /api/hello/slow')).toHaveLength(1)
      expect(store.getState().run.state!.annotations).toContainEqual(
        expect.objectContaining({
          level: 'notice',
          stepKey: SLOW_KEY,
          message: `step ${SLOW_KEY} resumed from scratch — its initial response was not recorded`,
        }),
      )
    } finally {
      server.events.removeListener('request:start', onRequestStart)
    }
  })
})
