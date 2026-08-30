import { describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import helloYaml from '../../../../docs/spec/examples/hello.workflow.yaml?raw'
import { loadWorkflow } from '../definition'
import { runReducer } from '../reducer'
import type { Definition, FileRef, RunEvent, RunState, Step, StepState } from '../types'
import { stepKey } from '../types'
import { runPipelineStep, type Clock, type HttpJson, type StepRuntime } from './pipeline'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition

function stepOf(def: Definition, job: string, id: string): Step {
  const step = def.jobs[job]?.steps.find((s) => s.id === id)
  if (!step) throw new Error(`no such step ${job}.${id}`)
  return step
}

type Canned = { status: number; body: unknown; logId?: string } | { throws: Error }

interface HttpCall {
  path: string
  method: string
  query?: Record<string, unknown>
  body?: unknown
}

/** A scripted `HttpJson`: a queue of canned responses that records every call. */
function fakeHttp(queue: Canned[]): { http: HttpJson; calls: HttpCall[] } {
  const calls: HttpCall[] = []
  const pending = [...queue]
  const http: HttpJson = async (path, init) => {
    calls.push({ path, method: init.method, query: init.query, body: init.body })
    const next = pending.shift()
    if (!next) throw new Error(`fakeHttp: unexpected call to ${path}`)
    if ('throws' in next) throw next.throws
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      body: next.body,
      // Absent, never `null`, when the canned response names no log — the
      // shape `httpJson` promises (apps#528).
      ...(next.logId === undefined ? {} : { logId: next.logId }),
    }
  }
  return { http, calls }
}

/**
 * A `StepRuntime` over a virtual clock (`sleep` resolves immediately and only
 * records the requested delay) whose `emit` **folds every event through the real
 * reducer** — so an illegal step transition fails the test at the emit site.
 */
function harness(state: RunState, http: HttpJson, opts: { onSleep?: (ms: number) => void } = {}) {
  const events: RunEvent[] = []
  const sleeps: number[] = []
  const controller = new AbortController()
  let now = 1_000
  let current = state

  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
      opts.onSleep?.(ms)
    },
  }

  const rt: StepRuntime = {
    emit: (event) => {
      events.push(event)
      current = runReducer(current, event)
    },
    http,
    clock,
    signal: controller.signal,
    registerFile: async (path): Promise<FileRef> => ({
      path,
      name: path.split('/').pop() ?? path,
      contentType: 'image/png',
      size: 7,
      url: `/api/workflow/files/${path}`,
    }),
  }

  return {
    rt,
    events,
    sleeps,
    controller,
    state: () => current,
    types: () => events.map((e) => e.type),
    advance: (ms: number) => {
      now += ms
    },
  }
}

function baseState(over: Partial<RunState> = {}): RunState {
  return {
    runId: 'run_TEST',
    impl: 'hello',
    workflow: 'hello',
    status: 'running',
    headless: false,
    unattended: false,
    inputs: { greeting: 'Hello', names: ['world'], photo: null, shout: false },
    steps: {},
    expansions: {},
    annotations: [],
    startedAt: 1_000,
    ...over,
  }
}

function queuedStep(
  job: string,
  index: number,
  stepId: string,
  kind: StepState['kind'] = 'pipeline',
): StepState {
  return {
    key: stepKey(job, index, stepId),
    job,
    index,
    stepId,
    kind,
    status: 'queued',
    attempt: 1,
    annotations: [],
  }
}

function succeededStep(
  job: string,
  index: number,
  stepId: string,
  outputs: Record<string, unknown>,
): StepState {
  return { ...queuedStep(job, index, stepId), status: 'succeeded', outputs }
}

const started = (e: RunEvent) => e as Extract<RunEvent, { type: 'step.started' }>
const polling = (e: RunEvent) => e as Extract<RunEvent, { type: 'step.polling' }>
const succeeded = (e: RunEvent) => e as Extract<RunEvent, { type: 'step.succeeded' }>
const failed = (e: RunEvent) => e as Extract<RunEvent, { type: 'step.failed' }>
const retrying = (e: RunEvent) => e as Extract<RunEvent, { type: 'step.retrying' }>

// ---------------------------------------------------------------------------
// A synchronous call — hello's `greet.say`
// ---------------------------------------------------------------------------

describe('runPipelineStep — synchronous pipeline (hello greet.say)', () => {
  const key = stepKey('greet', 0, 'say')

  function sayState(): RunState {
    return baseState({
      expansions: { greet: { total: 1, items: [{ who: 'world' }] } },
      steps: { [key]: queuedStep('greet', 0, 'say') },
    })
  }

  it('POSTs the interpolated body, coerces outputs and renders the summary', async () => {
    const { http, calls } = fakeHttp([{ status: 200, body: { text: 'Hello, world!' } }])
    const h = harness(sayState(), http)

    await runPipelineStep(
      { step: stepOf(hello, 'greet', 'say'), key, job: 'greet', index: 0, def: hello, state: sayState() },
      h.rt,
    )

    expect(h.types()).toEqual(['step.started', 'step.succeeded'])
    expect(calls).toEqual([
      {
        path: '/api/hello/echo',
        method: 'POST',
        query: undefined,
        body: { text: 'Hello, world!', upper: false },
      },
    ])

    // The whole evaluated `with` is the Input pane (03).
    expect(started(h.events[0]!).inputs).toEqual({
      path: 'echo',
      body: { text: 'Hello, world!', upper: false },
    })

    const ok = succeeded(h.events[1]!)
    expect(ok.outputs).toEqual({ line: 'Hello, world!' })
    expect(ok.summary).toBe('Said **Hello, world!**')
    expect(ok.response).toEqual({ initial: { text: 'Hello, world!' } })
    expect(h.state().steps[key]!.status).toBe('succeeded')
  })

  it('maps a non-2xx body onto error.code / error.status', async () => {
    const { http } = fakeHttp([{ status: 418, body: { code: 'TEAPOT', message: 'no coffee' } }])
    const h = harness(sayState(), http)

    await runPipelineStep(
      { step: stepOf(hello, 'greet', 'say'), key, job: 'greet', index: 0, def: hello, state: sayState() },
      h.rt,
    )

    expect(h.types()).toEqual(['step.started', 'step.failed'])
    expect(failed(h.events[1]!).error).toEqual({
      code: 'TEAPOT',
      message: 'no coffee',
      status: 418,
    })
  })

  it('falls back to HTTP_<status> when the body carries no code', async () => {
    const { http } = fakeHttp([{ status: 500, body: { detail: 'boom' } }])
    const h = harness(sayState(), http)

    await runPipelineStep(
      { step: stepOf(hello, 'greet', 'say'), key, job: 'greet', index: 0, def: hello, state: sayState() },
      h.rt,
    )

    expect(failed(h.events[1]!).error.code).toBe('HTTP_500')
  })

  it('maps a thrown fetch onto NETWORK', async () => {
    const { http } = fakeHttp([{ throws: new TypeError('Failed to fetch') }])
    const h = harness(sayState(), http)

    await runPipelineStep(
      { step: stepOf(hello, 'greet', 'say'), key, job: 'greet', index: 0, def: hello, state: sayState() },
      h.rt,
    )

    expect(h.types()).toEqual(['step.started', 'step.failed'])
    expect(failed(h.events[1]!).error).toEqual({ code: 'NETWORK', message: 'Failed to fetch' })
  })

  it('exposes a non-JSON 2xx body as the raw response string', async () => {
    const { http } = fakeHttp([{ status: 200, body: 'plain text' }])
    const noOutputs = toDefinition({
      name: 'Raw',
      jobs: { j: { steps: [{ id: 's', uses: 'pipeline', with: { path: 'echo' } }], outputs: {} } },
      outputs: {},
    }) as Definition
    const k = stepKey('j', 0, 's')
    const state = baseState({ steps: { [k]: queuedStep('j', 0, 's') } })
    const h = harness(state, http)

    await runPipelineStep(
      { step: stepOf(noOutputs, 'j', 's'), key: k, job: 'j', index: 0, def: noOutputs, state },
      h.rt,
    )

    // No `outputs` map ⇒ the step exposes exactly `response` (03).
    expect(succeeded(h.events[1]!).outputs).toEqual({ response: 'plain text' })
  })
})

// ---------------------------------------------------------------------------
// Polling — hello's `slow.start`
// ---------------------------------------------------------------------------

const SLOW_KEY = stepKey('slow', 0, 'start')

function slowState(): RunState {
  return baseState({
    expansions: { greet: { total: 1, items: [{ who: 'world' }] } },
    steps: {
      [stepKey('greet', 0, 'say')]: succeededStep('greet', 0, 'say', { line: 'Hello, world!' }),
      [SLOW_KEY]: queuedStep('slow', 0, 'start'),
    },
  })
}

function runSlow(h: ReturnType<typeof harness>, state: RunState) {
  return runPipelineStep(
    { step: stepOf(hello, 'slow', 'start'), key: SLOW_KEY, job: 'slow', index: 0, def: hello, state },
    h.rt,
  )
}

describe('runPipelineStep — poll (hello slow.start)', () => {
  it('emits polling with the initial response, ticks until `until`, and keeps `initial` readable', async () => {
    // The ticks are shaped like a real status endpoint: they answer with the
    // job's state, NOT with a copy of the job id — the poll `query` keeps
    // working because it is bound to the initial response.
    const { http, calls } = fakeHttp([
      { status: 200, body: { jobId: 'j1' } },
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'pending' } },
      {
        status: 200,
        body: {
          id: 'j1',
          status: 'done',
          result: { markdown: '# report', posterPath: 'shots/poster.png', ms: 1200 },
        },
      },
    ])
    const state = slowState()
    const h = harness(state, http)

    await runSlow(h, state)

    expect(h.types()).toEqual(['step.started', 'step.polling', 'step.succeeded'])

    // The initial `with` was evaluated against needs/inputs/step contexts.
    expect(started(h.events[0]!).inputs).toEqual({
      path: 'slow',
      body: {
        lines: ['Hello, world!'],
        photo: null, // `inputs.photo.path` on a null photo (any miss is null)
        outPrefix: 'workflows/hello/hello/runs/run_TEST/slow/0/start',
      },
    })

    // step.polling carries the UNTRIMMED initial response (rows.ts caps the row).
    expect(polling(h.events[1]!).initial).toEqual({ jobId: 'j1' })

    // GET /api/hello/job?id=j1, once per tick — `id` stays `j1` on every tick
    // because `query` reads the initial response (01:149, 03:33) — `every: 2s`
    // between ticks.
    expect(calls.slice(1)).toEqual([
      { path: '/api/hello/job', method: 'GET', query: { id: 'j1' }, body: undefined },
      { path: '/api/hello/job', method: 'GET', query: { id: 'j1' }, body: undefined },
      { path: '/api/hello/job', method: 'GET', query: { id: 'j1' }, body: undefined },
    ])
    expect(h.sleeps).toEqual([2000, 2000])

    const ok = succeeded(h.events[2]!)
    expect(ok.outputs).toEqual({
      report: '# report',
      poster: {
        path: 'shots/poster.png',
        name: 'poster.png',
        contentType: 'image/png',
        size: 7,
        url: '/api/workflow/files/shots/poster.png',
      },
    })
    expect(ok.annotations).toEqual([{ level: 'notice', message: 'Job j1 took 1200 ms' }])

    // `response` = { initial, last }; the initial stays readable after the fold.
    expect(ok.response?.initial).toEqual({ jobId: 'j1' })
    expect((ok.response?.last as { status: string }).status).toBe('done')
    expect(h.state().steps[SLOW_KEY]!.response?.initial).toEqual({ jobId: 'j1' })
  })

  it('fails with the tick error when the `fail` expression holds', async () => {
    const { http } = fakeHttp([
      { status: 200, body: { jobId: 'j1' } },
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'error', code: 'BAD_INPUT', message: 'no photo' } },
    ])
    const state = slowState()
    const h = harness(state, http)

    await runSlow(h, state)

    // `retry.if` is `error.code == 'BUSY'` — a BAD_INPUT failure is terminal.
    expect(h.types()).toEqual(['step.started', 'step.polling', 'step.failed'])
    expect(failed(h.events[2]!).error).toEqual({ code: 'BAD_INPUT', message: 'no photo' })
  })

  // -------------------------------------------------------------------------
  // Resume of a `polling` row (Task 19; 05 Resume item 3, Decision 3)
  // -------------------------------------------------------------------------

  /** A `slow/0/start` row already `polling`, as replay would rebuild it. */
  function resumedSlowState(): RunState {
    return baseState({
      expansions: { greet: { total: 1, items: [{ who: 'world' }] } },
      steps: {
        [stepKey('greet', 0, 'say')]: succeededStep('greet', 0, 'say', { line: 'Hello, world!' }),
        [SLOW_KEY]: {
          ...queuedStep('slow', 0, 'start'),
          status: 'polling',
          inputs: {
            path: 'slow',
            body: { lines: ['Hello, world!'], photo: null, outPrefix: 'workflows/hello/hello/runs/run_TEST/slow/0/start' },
          },
          response: { initial: { jobId: 'j1' } },
          startedAt: 1_000,
        },
      },
    })
  }

  it('resume (poll-only): skips the initial request and re-enters the poll loop with the recorded initial response', async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: { status: 'pending' } },
      {
        status: 200,
        body: { id: 'j1', status: 'done', result: { markdown: '# report', posterPath: null, ms: 500 } },
      },
    ])
    const state = resumedSlowState()
    const h = harness(state, http)

    await runPipelineStep(
      {
        step: stepOf(hello, 'slow', 'start'),
        key: SLOW_KEY,
        job: 'slow',
        index: 0,
        def: hello,
        state,
        resume: { mode: 'poll-only', initial: { jobId: 'j1' } },
      },
      h.rt,
    )

    // No `step.started` — that would be `polling -> running`, illegal; only
    // the self-transition `step.polling` re-affirms the recorded status.
    expect(h.types()).toEqual(['step.polling', 'step.succeeded'])
    expect(polling(h.events[0]!).initial).toEqual({ jobId: 'j1' })
    // The initial POST is never re-issued — only the poll ticks are.
    expect(calls).toEqual([
      { path: '/api/hello/job', method: 'GET', query: { id: 'j1' }, body: undefined },
      { path: '/api/hello/job', method: 'GET', query: { id: 'j1' }, body: undefined },
    ])
    expect(succeeded(h.events[1]!).outputs).toEqual({ report: '# report', poster: null })
  })

  it('resume (poll-only): a retry after the resumed poll fails re-issues the initial request', async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: { status: 'error', code: 'BUSY' } }, // the resumed poll's first tick
      { status: 200, body: { jobId: 'j2' } }, // the retry's fresh POST
      { status: 200, body: { status: 'pending' } },
      {
        status: 200,
        body: { id: 'j2', status: 'done', result: { markdown: '# ok', posterPath: null, ms: 10 } },
      },
    ])
    const state = resumedSlowState()
    const h = harness(state, http)

    await runPipelineStep(
      {
        step: stepOf(hello, 'slow', 'start'),
        key: SLOW_KEY,
        job: 'slow',
        index: 0,
        def: hello,
        state,
        resume: { mode: 'poll-only', initial: { jobId: 'j1' } },
      },
      h.rt,
    )

    expect(h.types()).toEqual([
      'step.polling', // the resumed self-transition
      'step.retrying', // `error.code == 'BUSY'` from the resumed poll's `fail`
      'step.started', // the retry re-evaluates `with` and re-POSTs — no `resume` carries over
      'step.polling',
      'step.succeeded',
    ])
    expect(calls[0]).toEqual({ path: '/api/hello/job', method: 'GET', query: { id: 'j1' }, body: undefined })
    expect(calls[1]?.path).toBe('/api/hello/slow')
    expect(calls[1]?.method).toBe('POST')
  })

  // Task 13 (M1 minor): a `polling` row whose recorded `initial` was stubbed by
  // `trimResponse` has nothing to resume *from* — the poll's request context
  // reads `response.jobId` off it. The only legal way back is to re-issue the
  // initial request from a row that is already `polling`, which means no
  // `step.started` (that would be `polling -> running`).
  it('resume (restart): re-issues the initial request with no step.started, then polls it', async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: { jobId: 'j9' } }, // the re-request
      { status: 200, body: { status: 'pending' } },
      {
        status: 200,
        body: { id: 'j9', status: 'done', result: { markdown: '# again', posterPath: null, ms: 5 } },
      },
    ])
    const state = resumedSlowState()
    const h = harness(state, http)

    await runPipelineStep(
      {
        step: stepOf(hello, 'slow', 'start'),
        key: SLOW_KEY,
        job: 'slow',
        index: 0,
        def: hello,
        state,
        resume: { mode: 'restart' },
      },
      h.rt,
    )

    expect(h.types()).toEqual(['step.polling', 'step.succeeded'])
    // The recorded `with` is reused verbatim — a resumed row cannot announce
    // freshly evaluated inputs, because `step.started` is the only event that
    // carries them and it has no legal edge from `polling`.
    expect(calls[0]).toEqual({
      path: '/api/hello/slow',
      method: 'POST',
      query: undefined,
      body: resumedSlowState().steps[SLOW_KEY]!.inputs!.body,
    })
    // The poll runs against the *fresh* initial, not the stubbed one.
    expect(polling(h.events[0]!).initial).toEqual({ jobId: 'j9' })
    expect(calls[1]).toEqual({ path: '/api/hello/job', method: 'GET', query: { id: 'j9' }, body: undefined })
    expect(succeeded(h.events[1]!).outputs).toEqual({ report: '# again', poster: null })
  })

  // Review minor 2: the fail-closed guard must fire *before* any request. A
  // `poll-only` resume never had a side effect to get wrong (it issues nothing);
  // `restart` does, so the guard moved ahead of the re-request.
  it('resume: a row that says `polling` for a step with no `poll:` fails closed in either mode, with no request', async () => {
    const GREET_KEY = stepKey('greet', 0, 'say')
    const modes = [{ mode: 'poll-only' as const, initial: { text: 'Hello, world!' } }, { mode: 'restart' as const }]

    for (const resume of modes) {
      const { http, calls } = fakeHttp([])
      const state = baseState({
        expansions: { greet: { total: 1, items: [{ who: 'world' }] } },
        steps: {
          [GREET_KEY]: {
            ...queuedStep('greet', 0, 'say'),
            status: 'polling',
            inputs: { path: 'echo', body: { text: 'Hello, world!', upper: false } },
            response: { initial: { text: 'Hello, world!' } },
            startedAt: 1_000,
          },
        },
      })
      const h = harness(state, http)

      await runPipelineStep(
        {
          step: stepOf(hello, 'greet', 'say'),
          key: GREET_KEY,
          job: 'greet',
          index: 0,
          def: hello,
          state,
          resume,
        },
        h.rt,
      )

      expect(h.types()).toEqual(['step.failed'])
      expect(failed(h.events[0]!).error.message).toBe('resumed a polling row but the step has no `poll:`')
      expect(calls).toEqual([])
    }
  })

  it('emits step.cancelled when the run is aborted mid-poll', async () => {
    const { http, calls } = fakeHttp([
      { status: 200, body: { jobId: 'j1' } },
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'pending' } },
    ])
    const state = slowState()
    const h: ReturnType<typeof harness> = harness(state, http, {
      onSleep: () => h.controller.abort(),
    })

    await runSlow(h, state)

    expect(h.types()).toEqual(['step.started', 'step.polling', 'step.cancelled'])
    expect(calls).toHaveLength(2) // initial + one tick; the second tick never fires
    expect(h.state().steps[SLOW_KEY]!.status).toBe('cancelled')
  })

  it('binds the poll query to the initial response, not to the latest tick', async () => {
    const chain = toDefinition({
      name: 'Chain',
      jobs: {
        j: {
          steps: [
            {
              id: 's',
              uses: 'pipeline',
              with: { path: 'start' },
              poll: {
                path: 'tick',
                query: { cursor: '${{ response.next }}' },
                until: "${{ response.status == 'done' }}",
                every: '1s',
                timeout: '1m',
              },
            },
          ],
          outputs: {},
        },
      },
      outputs: {},
    }) as Definition
    const { http, calls } = fakeHttp([
      { status: 200, body: { next: 'c1' } },
      { status: 200, body: { next: 'c2', status: 'pending' } },
      { status: 200, body: { next: 'c3', status: 'done' } },
    ])
    const k = stepKey('j', 0, 's')
    const state = baseState({ steps: { [k]: queuedStep('j', 0, 's') } })
    const h = harness(state, http)

    await runPipelineStep(
      { step: stepOf(chain, 'j', 's'), key: k, job: 'j', index: 0, def: chain, state },
      h.rt,
    )

    // 01:149 / 03:33 — `query`/`body` see the INITIAL response; only `fail`,
    // `until` and `outputs` see the tick's own response.
    expect(h.types()).toEqual(['step.started', 'step.polling', 'step.succeeded'])
    expect(calls[1]!.query).toEqual({ cursor: 'c1' })
    expect(calls[2]!.query).toEqual({ cursor: 'c1' }) // NOT c2, tick 1's `next`
    // ...while `until` did read tick 2's own response to end the poll.
    expect(succeeded(h.events[2]!).outputs).toEqual({ response: { next: 'c3', status: 'done' } })
  })

  it('fails with POLL_TIMEOUT once the poll budget is spent', async () => {
    const slowPoll = toDefinition({
      name: 'Slow poll',
      jobs: {
        j: {
          steps: [
            {
              id: 's',
              uses: 'pipeline',
              with: { path: 'start' },
              poll: {
                path: 'tick',
                until: "${{ response.status == 'done' }}",
                every: '2s',
                timeout: '4s',
              },
            },
          ],
          outputs: {},
        },
      },
      outputs: {},
    }) as Definition
    const { http } = fakeHttp([
      { status: 200, body: { jobId: 'j1' } },
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'pending' } },
    ])
    const k = stepKey('j', 0, 's')
    const state = baseState({ steps: { [k]: queuedStep('j', 0, 's') } })
    const h = harness(state, http)

    await runPipelineStep(
      { step: stepOf(slowPoll, 'j', 's'), key: k, job: 'j', index: 0, def: slowPoll, state },
      h.rt,
    )

    expect(h.types()).toEqual(['step.started', 'step.polling', 'step.failed'])
    expect(failed(h.events[2]!).error.code).toBe('POLL_TIMEOUT')
  })

  it('fails with TIMEOUT once the step `timeout-minutes` budget is spent', async () => {
    const bounded = toDefinition({
      name: 'Bounded',
      jobs: {
        j: {
          steps: [
            {
              id: 's',
              uses: 'pipeline',
              'timeout-minutes': 1,
              with: { path: 'start' },
              poll: {
                path: 'tick',
                until: "${{ response.status == 'done' }}",
                every: '30s',
                timeout: '10m',
              },
            },
          ],
          outputs: {},
        },
      },
      outputs: {},
    }) as Definition
    const { http } = fakeHttp(
      Array.from({ length: 8 }, () => ({ status: 200, body: { status: 'pending' } })),
    )
    const k = stepKey('j', 0, 's')
    const state = baseState({ steps: { [k]: queuedStep('j', 0, 's') } })
    const h = harness(state, http)

    await runPipelineStep(
      { step: stepOf(bounded, 'j', 's'), key: k, job: 'j', index: 0, def: bounded, state },
      h.rt,
    )

    expect(h.types()).toEqual(['step.started', 'step.polling', 'step.failed'])
    expect(failed(h.events[2]!).error.code).toBe('TIMEOUT')
    expect(h.sleeps).toEqual([30_000, 30_000])
  })
})

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe('runPipelineStep — retry (hello slow.start, `retry.if` on BUSY)', () => {
  it('retries a matching failure after `delay` and re-runs the whole step', async () => {
    const { http, calls } = fakeHttp([
      { status: 503, body: { code: 'BUSY', message: 'server busy' } },
      { status: 200, body: { jobId: 'j2' } },
      { status: 200, body: { id: 'j2', status: 'done', result: { markdown: '# r', posterPath: null, ms: 5 } } },
    ])
    const state = slowState()
    const h = harness(state, http)

    await runSlow(h, state)

    expect(h.types()).toEqual([
      'step.started',
      'step.retrying',
      'step.started',
      'step.polling',
      'step.succeeded',
    ])
    expect(retrying(h.events[1]!).error).toEqual({
      code: 'BUSY',
      message: 'server busy',
      status: 503,
    })
    expect(h.sleeps[0]).toBe(3000) // retry.delay
    expect(calls[1]!.path).toBe('/api/hello/slow') // the whole step re-ran
    expect(h.state().steps[SLOW_KEY]!.attempt).toBe(2)
    expect(succeeded(h.events[4]!).outputs).toMatchObject({ report: '# r' })
  })

  it('gives `retry.if` the last response alongside the error', async () => {
    const onResponse = toDefinition({
      name: 'Retry on response',
      jobs: {
        j: {
          steps: [
            {
              id: 's',
              uses: 'pipeline',
              with: { path: 'start' },
              poll: {
                path: 'tick',
                until: "${{ response.status == 'done' }}",
                fail: "${{ response.status == 'error' }}",
                every: '1s',
                timeout: '1m',
              },
              retry: { max: 1, delay: '1s', if: "${{ response.status == 'error' }}" },
            },
          ],
          outputs: {},
        },
      },
      outputs: {},
    }) as Definition
    const { http } = fakeHttp([
      { status: 200, body: { jobId: 'j1' } },
      { status: 200, body: { status: 'error' } },
      { status: 200, body: { jobId: 'j2' } },
      { status: 200, body: { status: 'done' } },
    ])
    const k = stepKey('j', 0, 's')
    const state = baseState({ steps: { [k]: queuedStep('j', 0, 's') } })
    const h = harness(state, http)

    await runPipelineStep(
      { step: stepOf(onResponse, 'j', 's'), key: k, job: 'j', index: 0, def: onResponse, state },
      h.rt,
    )

    expect(h.types()).toEqual([
      'step.started',
      'step.polling',
      'step.retrying',
      'step.started',
      'step.polling',
      'step.succeeded',
    ])
    expect(retrying(h.events[2]!).error.code).toBe('POLL_FAILED')
  })

  it('does not retry a failure that `retry.if` rejects', async () => {
    const { http, calls } = fakeHttp([{ status: 503, body: { code: 'OTHER', message: 'nope' } }])
    const state = slowState()
    const h = harness(state, http)

    await runSlow(h, state)

    expect(h.types()).toEqual(['step.started', 'step.failed'])
    expect(calls).toHaveLength(1)
    expect(h.sleeps).toEqual([])
    expect(failed(h.events[1]!).error.code).toBe('OTHER')
  })

  it('fails with the last error once `max` extra attempts are exhausted', async () => {
    const busy = { status: 503, body: { code: 'BUSY', message: 'still busy' } }
    const { http, calls } = fakeHttp([busy, busy, busy])
    const state = slowState()
    const h = harness(state, http)

    await runSlow(h, state)

    // `max: 2` ⇒ up to three runs.
    expect(h.types()).toEqual([
      'step.started',
      'step.retrying',
      'step.started',
      'step.retrying',
      'step.started',
      'step.failed',
    ])
    expect(calls).toHaveLength(3)
    expect(h.sleeps).toEqual([3000, 3000])
    expect(failed(h.events[5]!).error).toEqual({ code: 'BUSY', message: 'still busy', status: 503 })
    expect(h.state().steps[SLOW_KEY]!.attempt).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Output typing and cancellation before the first request
// ---------------------------------------------------------------------------

describe('runPipelineStep — annotations on the failure path', () => {
  function annotated(entries: unknown[]): Definition {
    return toDefinition({
      name: 'Annotated',
      jobs: {
        j: {
          steps: [{ id: 's', uses: 'pipeline', with: { path: 'boom' }, annotations: entries }],
          outputs: {},
        },
      },
      outputs: {},
    }) as Definition
  }

  async function runAnnotated(def: Definition) {
    const { http } = fakeHttp([{ status: 503, body: { code: 'BUSY', message: 'busy' } }])
    const k = stepKey('j', 0, 's')
    const state = baseState({ steps: { [k]: queuedStep('j', 0, 's') } })
    const h = harness(state, http)
    await runPipelineStep(
      { step: stepOf(def, 'j', 's'), key: k, job: 'j', index: 0, def, state },
      h.rt,
    )
    return h
  }

  it('evaluates annotations with `error` in scope when the step fails', async () => {
    // `error` is only populated on a failure — annotations are the site that
    // reads it (01: contexts table).
    const h = await runAnnotated(
      annotated([{ level: 'error', message: 'pipeline said ${{ error.code }}' }]),
    )

    expect(h.types()).toEqual(['step.started', 'step.failed'])
    expect(failed(h.events[1]!).annotations).toEqual([
      { level: 'error', message: 'pipeline said BUSY' },
    ])
    expect(h.state().steps[stepKey('j', 0, 's')]!.annotations).toEqual([
      { level: 'error', message: 'pipeline said BUSY' },
    ])
  })

  it('drops an annotation it cannot evaluate rather than masking the step error', async () => {
    const h = await runAnnotated(
      annotated([
        { level: 'warning', message: 'broken ${{ error.code == }}' },
        { level: 'error', message: 'kept ${{ error.code }}' },
      ]),
    )

    expect(h.types()).toEqual(['step.started', 'step.failed'])
    expect(failed(h.events[1]!).error.code).toBe('BUSY')
    expect(failed(h.events[1]!).annotations).toEqual([{ level: 'error', message: 'kept BUSY' }])
  })

  it('applies an annotation `if` on the failure path', async () => {
    const h = await runAnnotated(
      annotated([
        { level: 'notice', message: 'never', if: "${{ error.code == 'OTHER' }}" },
        { level: 'error', message: 'always' },
      ]),
    )

    expect(failed(h.events[1]!).annotations).toEqual([{ level: 'error', message: 'always' }])
  })
})

describe('runPipelineStep — failure mapping', () => {
  const typed = toDefinition({
    name: 'Typed',
    jobs: {
      j: {
        steps: [
          {
            id: 's',
            uses: 'pipeline',
            with: { path: 'echo' },
            outputs: { total: { type: 'number', value: '${{ response.total }}' } },
          },
        ],
        outputs: {},
      },
    },
    outputs: {},
  }) as Definition
  const k = stepKey('j', 0, 's')

  it('fails with OUTPUT_TYPE when a declared output does not match its type', async () => {
    const { http } = fakeHttp([{ status: 200, body: { total: 'twelve' } }])
    const state = baseState({ steps: { [k]: queuedStep('j', 0, 's') } })
    const h = harness(state, http)

    await runPipelineStep(
      { step: stepOf(typed, 'j', 's'), key: k, job: 'j', index: 0, def: typed, state },
      h.rt,
    )

    expect(h.types()).toEqual(['step.started', 'step.failed'])
    expect(failed(h.events[1]!).error.code).toBe('OUTPUT_TYPE')
  })

  it('cancels without calling the pipeline when the run is already aborted', async () => {
    const { http, calls } = fakeHttp([])
    const state = baseState({ steps: { [k]: queuedStep('j', 0, 's') } })
    const h = harness(state, http)
    h.controller.abort()

    await runPipelineStep(
      { step: stepOf(typed, 'j', 's'), key: k, job: 'j', index: 0, def: typed, state },
      h.rt,
    )

    expect(h.types()).toEqual(['step.cancelled'])
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The execution log id (apps#528)
// ---------------------------------------------------------------------------

describe('runPipelineStep — the execution log id (apps#528)', () => {
  const key = stepKey('greet', 0, 'say')

  function sayState(): RunState {
    return baseState({
      expansions: { greet: { total: 1, items: [{ who: 'world' }] } },
      steps: { [key]: queuedStep('greet', 0, 'say') },
    })
  }

  function runSay(h: ReturnType<typeof harness>, state: RunState) {
    return runPipelineStep(
      { step: stepOf(hello, 'greet', 'say'), key, job: 'greet', index: 0, def: hello, state },
      h.rt,
    )
  }

  it('lands the response header id on step.succeeded, and on the state', async () => {
    const { http } = fakeHttp([{ status: 200, body: { text: 'Hello, world!' }, logId: 'plog_ok' }])
    const state = sayState()
    const h = harness(state, http)

    await runSay(h, state)

    expect(succeeded(h.events[1]!).logId).toBe('plog_ok')
    expect(h.state().steps[key]!.logId).toBe('plog_ok')
  })

  it('lands the failing execution\'s id on step.failed', async () => {
    const { http } = fakeHttp([
      { status: 500, body: { code: 'BOOM', message: 'handler threw' }, logId: 'plog_fail' },
    ])
    const state = sayState()
    const h = harness(state, http)

    await runSay(h, state)

    expect(h.types()).toEqual(['step.started', 'step.failed'])
    expect(failed(h.events[1]!).logId).toBe('plog_fail')
    expect(h.state().steps[key]!.logId).toBe('plog_fail')
  })

  it('carries no id at all when no response named one (debug-off success)', async () => {
    const { http } = fakeHttp([{ status: 200, body: { text: 'Hello, world!' } }])
    const state = sayState()
    const h = harness(state, http)

    await runSay(h, state)

    expect('logId' in succeeded(h.events[1]!)).toBe(false)
    expect(h.state().steps[key]!.logId).toBeUndefined()
  })

  it('last response wins across a poll, but a headerless tick does not erase it', async () => {
    const { http } = fakeHttp([
      { status: 200, body: { jobId: 'j1' }, logId: 'plog_initial' },
      { status: 200, body: { status: 'pending' }, logId: 'plog_tick' },
      { status: 200, body: { status: 'done', result: { markdown: '# r', posterPath: 'p.png', ms: 1 } } },
    ])
    const state = slowState()
    const h = harness(state, http)

    await runSlow(h, state)

    // The final (headerless) tick keeps the last id a response did name.
    expect(succeeded(h.events[2]!).logId).toBe('plog_tick')
  })
})
