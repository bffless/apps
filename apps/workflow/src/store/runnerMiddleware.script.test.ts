/**
 * The `script` step, in the middleware (Task 11, Decision 13).
 *
 * A script is the one step kind the middleware drives end to end on its own:
 * there is no DOM to hand over (unlike an island) and no human to wait for
 * (unlike a form), so everything observable lives in the events the launcher
 * emits around `ScriptHost.run` — `started` with the evaluated `with`,
 * `annotated` while it runs, and one terminal event carrying either the
 * coerced outputs or the failure's own code.
 *
 * The Worker/RPC half is proven in `scripts/ScriptHost.test.ts`; what these
 * tests care about is the *wiring*, so the host here is a hand-written double
 * injected through `RunnerDeps.scriptHost` whose run stays pending until the
 * test settles it. The output path is deliberately **not** faked: a returned
 * `Blob` goes through the real `uploadBlob` against the MSW files trio, so
 * the persisted row really does hold a File ref under the run's own scope.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { httpJson } from '../lib/http'
import { replayRun } from '../lib/runner/replay'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import { createRunStore } from '../lib/runStore'
import { db, stepRowKey } from '../mocks/db'
import { server } from '../mocks/server'
import type { ScriptHost, ScriptHostDeps, ScriptRunArgs } from '../scripts/ScriptHost'
import { getScriptLog } from '../scripts/logStore'
import type { AppStore } from '../store'
import { makeStore } from '../store'
import { flush, pumpUntil, virtualClock } from '../test/helloHarness'
import { cancelRun } from './lifecycleActions'
import { createRegisterFile, runnerControllers } from './runnerMiddleware'
import type { RunnerDeps } from './runnerMiddleware'
import { startRun } from './runnerActions'
import { runClosed, runOpened, runReplaced } from './runSlice'

// ---------------------------------------------------------------------------
// A one-job workflow whose only step is a script
// ---------------------------------------------------------------------------

const SCRIPT_YAML = 'name: Scripted\n'
const SCRIPT_KEY: StepKey = stepKey('make', 0, 'poster')

function scriptDef(over: Record<string, unknown> = {}): Definition {
  return toDefinition({
    name: 'Scripted',
    jobs: {
      make: {
        steps: [
          {
            id: 'poster',
            uses: 'script',
            with: { src: 'scripts/poster.js', label: '${{ inputs.label }}' },
            outputs: { poster: { type: 'file' }, count: { type: 'number' } },
            summary: 'Rendered ${{ steps.poster.outputs.count }} frames',
            annotations: [{ level: 'notice', message: 'poster is ${{ steps.poster.outputs.count }}f' }],
            ...over,
          },
        ],
        outputs: { poster: '${{ steps.poster.outputs.poster }}' },
      },
    },
    outputs: { poster: '${{ jobs.make.outputs.poster }}' },
  }) as Definition
}

/** The same workflow with no `with.src` at all — a definition bug the linter would have caught. */
const NO_SRC_DEF = toDefinition({
  name: 'Scripted',
  jobs: {
    make: {
      steps: [{ id: 'poster', uses: 'script', with: { label: 'x' }, outputs: {} }],
    },
  },
}) as Definition

// ---------------------------------------------------------------------------
// The fake host
// ---------------------------------------------------------------------------

function abortError(message: string): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

interface FakeScriptHost {
  /** Pass as `RunnerDeps.scriptHost`. */
  factory: (deps: ScriptHostDeps) => ScriptHost
  /** The deps of the *latest* host built — `onLog`/`onAnnotate` live here. */
  deps: ScriptHostDeps | null
  /** Every `run` the launcher made, in order. */
  runs: ScriptRunArgs[]
  /** Make the next `run()` call throw synchronously (an off-bundle `src`). */
  throwOnRun: Error | null
  /** Resolve the oldest pending run with the module's return value. */
  settle(outputs: unknown): void
  /** Reject the oldest pending run. */
  fail(err: unknown): void
  pending(): number
}

function fakeScriptHost(): FakeScriptHost {
  const settlers: { resolve: (v: unknown) => void; reject: (err: unknown) => void }[] = []

  const fake: FakeScriptHost = {
    deps: null,
    runs: [],
    throwOnRun: null,
    pending: () => settlers.length,
    settle(outputs) {
      const next = settlers.shift()
      if (!next) throw new Error('fakeScriptHost: no pending run to settle')
      next.resolve(outputs)
    },
    fail(err) {
      const next = settlers.shift()
      if (!next) throw new Error('fakeScriptHost: no pending run to fail')
      next.reject(err)
    },
    factory: (deps) => {
      fake.deps = deps
      return {
        run(a) {
          if (fake.throwOnRun) {
            const err = fake.throwOnRun
            fake.throwOnRun = null
            throw err
          }
          fake.runs.push(a)

          let settler!: { resolve: (v: unknown) => void; reject: (err: unknown) => void }
          const outputs = new Promise<unknown>((resolve, reject) => {
            settler = { resolve, reject }
          })

          // Faithful on the one behaviour the wiring turns on: an abort — the
          // signal's or the caller's — rejects with a plain `AbortError`, and
          // nothing in the module is waited on afterwards.
          const abort = () => {
            const i = settlers.indexOf(settler)
            if (i >= 0) settlers.splice(i, 1)
            settler.reject(abortError('script: cancelled'))
          }

          if (a.signal.aborted) abort()
          else {
            settlers.push(settler)
            a.signal.addEventListener('abort', abort, { once: true })
          }

          return { outputs, abort }
        },
      }
    },
  }

  return fake
}

// ---------------------------------------------------------------------------
// A store wired to it, against the real MSW backend
// ---------------------------------------------------------------------------

const trackedStores: AppStore[] = []

interface ScriptRun {
  store: AppStore
  advance: (ms: number) => Promise<void>
  host: FakeScriptHost
  runId: string
}

function scriptStore(factory?: (deps: ScriptHostDeps) => ScriptHost): Omit<ScriptRun, 'runId'> {
  const host = fakeScriptHost()
  const { clock, advance } = virtualClock()
  const deps: RunnerDeps = {
    http: httpJson,
    clock,
    runStore: createRunStore(httpJson),
    registerFile: createRegisterFile(httpJson),
    scriptHost: factory ?? host.factory,
  }
  const store = makeStore(deps)
  trackedStores.push(store)
  return { store, advance, host }
}

/** Starts the workflow and pumps until the script step is `running` — i.e. the host is in flight. */
async function startScriptRun(
  def: Definition = scriptDef(),
  factory?: (deps: ScriptHostDeps) => ScriptHost,
): Promise<ScriptRun> {
  const { store, advance, host } = scriptStore(factory)
  store.dispatch(
    startRun({
      impl: 'hello',
      workflow: 'interactive',
      def,
      yaml: SCRIPT_YAML,
      workflowName: 'Scripted',
      values: { label: 'Hi' },
    }),
  )
  await pumpUntil(advance, () => store.getState().run.state?.steps[SCRIPT_KEY] !== undefined)
  return { store, advance, host, runId: store.getState().run.state!.runId }
}

function stepRow(runId: string) {
  return db.steps.get(stepRowKey(runId, SCRIPT_KEY))
}

afterEach(() => {
  for (const store of trackedStores) store.dispatch(runClosed())
  runnerControllers.abortAll()
  trackedStores.length = 0
})

// ---------------------------------------------------------------------------

describe('script steps — the happy path', () => {
  it('records the evaluated `with` as inputs, uploads a returned Blob, and succeeds', async () => {
    const { store, advance, host, runId } = await startScriptRun()

    // `queued → running`, with `src` consumed by the host rather than recorded.
    const started = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(started.status).toBe('running')
    expect(started.inputs).toEqual({ label: 'Hi' })
    expect(host.runs).toHaveLength(1)
    expect(host.runs[0].impl).toBe('hello')
    expect(host.runs[0].src).toBe('scripts/poster.js')
    expect(host.runs[0].inputs).toEqual({ label: 'Hi' })

    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 3 })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(step.status).toBe('succeeded')

    const path = `workflows/hello/interactive/runs/${runId}/${SCRIPT_KEY}/poster.svg`
    expect(step.outputs!.poster).toMatchObject({ path, name: 'poster.svg' })
    expect(step.outputs!.count).toBe(3)
    // The bytes really went through the files trio.
    expect(db.files.get(path)?.contentType).toBe('image/svg+xml')

    // And the row the record keeps says the same thing.
    const row = stepRow(runId)!
    expect(row.status).toBe('succeeded')
    expect((row.outputs as Record<string, { path: string }>).poster.path).toBe(path)

    expect(store.getState().run.state!.status).toBe('succeeded')
  })

  it('evaluates the step\'s own `summary:`/`annotations:` templates against its outputs', async () => {
    const { store, advance, host, runId } = await startScriptRun()

    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 3 })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(step.summary).toBe('Rendered 3 frames')
    expect(step.annotations).toEqual([{ level: 'notice', message: 'poster is 3f' }])
    expect(stepRow(runId)!.summary).toBe('Rendered 3 frames')
  })
})

describe('script steps — ctx.log and ctx.annotate', () => {
  it('persists the capped `ctx.log` tail on the succeeded row (apps#527)', async () => {
    const { store, advance, host, runId } = await startScriptRun()

    host.deps!.onLog('frame 1')
    host.deps!.onLog('frame 2')
    expect(getScriptLog(runId, SCRIPT_KEY)).toEqual(['frame 1', 'frame 2'])

    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 1 })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    // The terminal upsert carried the tail onto the row (apps#527)…
    expect(stepRow(runId)!.log).toEqual(['frame 1', 'frame 2'])
    // …into state, so a replayed run holds the same lines…
    expect(store.getState().run.state!.steps[SCRIPT_KEY].log).toEqual(['frame 1', 'frame 2'])
    // …and the live store still shows it until the runner resets.
    expect(getScriptLog(runId, SCRIPT_KEY)).toEqual(['frame 1', 'frame 2'])
  })

  it('a script that never logs writes no `log` column at all', async () => {
    const { store, advance, host, runId } = await startScriptRun()

    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 1 })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    expect(stepRow(runId)!.status).toBe('succeeded')
    expect('log' in stepRow(runId)!).toBe(false)
  })

  it('a failing script keeps its tail on the failed row (apps#527)', async () => {
    const { store, advance, host, runId } = await startScriptRun()

    host.deps!.onLog('about to blow')
    host.fail(new Error('boom'))
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const row = stepRow(runId)!
    expect(row.status).toBe('failed')
    expect(row.log).toEqual(['about to blow'])
  })

  it('cancel writes the tail the script had logged onto the cancelled row (apps#527)', async () => {
    const { store, host, runId } = await startScriptRun()

    host.deps!.onLog('frame 1')
    await store.dispatch(cancelRun())
    await flush()

    const row = stepRow(runId)!
    expect(row.status).toBe('cancelled')
    expect(row.log).toEqual(['frame 1'])
    expect(host.pending()).toBe(0)
  })

  it('lands `ctx.annotate` as step.annotated on the row before the step succeeds', async () => {
    const { store, advance, host, runId } = await startScriptRun()

    host.deps!.onAnnotate({
      summary: 'half way',
      annotations: [{ level: 'warning', message: 'slow frame' }],
    })
    await flush()

    const running = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(running.status).toBe('running')
    expect(running.summary).toBe('half way')
    expect(running.annotations).toEqual([{ level: 'warning', message: 'slow frame' }])
    // Persisted while still running — the record grows as the step goes.
    expect(stepRow(runId)!.annotations).toEqual([{ level: 'warning', message: 'slow frame' }])

    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 3 })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    // The dynamic annotation is kept and the declared one appended (Decision 12).
    expect(stepRow(runId)!.annotations).toEqual([
      { level: 'warning', message: 'slow frame' },
      { level: 'notice', message: 'poster is 3f' },
    ])
  })

  it('lands the module contract\'s single-annotation `ctx.annotate` too', async () => {
    // What a real script sends (03 / `@bffless/workflow-script`): one
    // annotation, not the row's `{ annotations: [...] }` shape.
    const { store, host, runId } = await startScriptRun()

    host.deps!.onAnnotate({ level: 'notice', message: 'card drawn' })
    await flush()

    expect(store.getState().run.state!.steps[SCRIPT_KEY].annotations).toEqual([
      { level: 'notice', message: 'card drawn' },
    ])
    expect(stepRow(runId)!.annotations).toEqual([{ level: 'notice', message: 'card drawn' }])
  })

  it('reports a rejected annotate on the log rather than throwing into the module', async () => {
    const { host, runId } = await startScriptRun()

    host.deps!.onAnnotate({ annotations: 'not a list' })
    await flush()

    expect(getScriptLog(runId, SCRIPT_KEY).join('\n')).toContain('annotate rejected')
    expect(getScriptLog(runId, SCRIPT_KEY).join('\n')).toContain('`annotations` must be a list')
  })

  it('leaves one run-level warning per step for a refused annotate, so the record keeps a trace (apps#375)', async () => {
    const { store, host, runId } = await startScriptRun()

    host.deps!.onAnnotate({ annotations: 'not a list' })
    host.deps!.onAnnotate({ annotations: 'still not a list' })
    await flush()

    const notices = store.getState().run.state!.annotations.filter((a) => a.stepKey === SCRIPT_KEY)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      level: 'warning',
      stepKey: SCRIPT_KEY,
      message: expect.stringContaining('ctx.annotate'),
    })
    // The live log has every refusal; the record has the one notice.
    expect(getScriptLog(runId, SCRIPT_KEY).filter((l) => l.includes('annotate rejected'))).toHaveLength(2)
    expect(db.runs.get(runId)!.annotations).toEqual(notices)
  })
})

describe('script steps — failure', () => {
  it('fails the step with the rejection\'s own code', async () => {
    const { store, advance, host } = await startScriptRun()

    const err = Object.assign(new Error('script: the renderer gave up'), { code: 'RENDER' })
    host.fail(err)
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(step.status).toBe('failed')
    expect(step.error).toEqual({ code: 'RENDER', message: 'script: the renderer gave up' })
    expect(store.getState().run.state!.status).toBe('failed')
  })

  it('fails OUTPUT_TYPE when the module returns the wrong shape', async () => {
    const { store, advance, host } = await startScriptRun()

    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 'three' })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(step.status).toBe('failed')
    expect(step.error?.code).toBe('OUTPUT_TYPE')
    expect(step.error?.message).toContain('count')
  })

  it('fails SCRIPT_LOAD when the step\'s `with` is a definition bug, after recording started', async () => {
    const { store, advance } = await startScriptRun(NO_SRC_DEF)

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(step.status).toBe('failed')
    expect(step.error?.code).toBe('SCRIPT_LOAD')
    expect(step.error?.message).toContain('src')
    // `queued → failed` is illegal: the row passed through `running` first.
    expect(step.startedAt).toBeDefined()
  })

  it('fails SCRIPT_LOAD when the host refuses the src synchronously', async () => {
    const { store, advance, host } = scriptStore()
    host.throwOnRun = new Error('script step poster: `with.src` escapes the bundle')
    store.dispatch(
      startRun({
        impl: 'hello',
        workflow: 'interactive',
        def: scriptDef(),
        yaml: SCRIPT_YAML,
        workflowName: 'Scripted',
        values: { label: 'Hi' },
      }),
    )

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(step.status).toBe('failed')
    expect(step.error?.code).toBe('SCRIPT_LOAD')
    expect(step.error?.message).toContain('escapes the bundle')
  })
})

describe('script steps — the `timeout-minutes` budget', () => {
  it('aborts the run and fails TIMEOUT once the budget is spent', async () => {
    const { store, advance, host } = await startScriptRun(scriptDef({ 'timeout-minutes': 1 }))
    expect(host.pending()).toBe(1)

    await advance(61_000)
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(step.status).toBe('failed')
    expect(step.error).toEqual({
      code: 'TIMEOUT',
      message: 'the step exceeded its `timeout-minutes` budget',
    })
    // The module was told to stop, not left running behind the run.
    expect(host.runs[0].signal.aborted).toBe(true)
  })

  it('records TIMEOUT, not succeeded, when the module resolves in the very tick the budget expires (apps#375)', async () => {
    // A host whose abort *resolves* the module (a Worker that answers `done`
    // on its way out) — the budget's `run.abort()` and the module's own
    // settlement then land in one tick, and `timedOut` is the only thing
    // that says which of the two the row should believe.
    const resolvingHost = (): ScriptHost => ({
      run() {
        let resolve!: (v: unknown) => void
        const outputs = new Promise<unknown>((r) => {
          resolve = r
        })
        return {
          outputs,
          abort: () => resolve({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 2 }),
        }
      },
    })
    const { store, advance } = await startScriptRun(scriptDef({ 'timeout-minutes': 1 }), () => resolvingHost())

    await advance(61_000)
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[SCRIPT_KEY]
    expect(step.status).toBe('failed')
    expect(step.error).toEqual({
      code: 'TIMEOUT',
      message: 'the step exceeded its `timeout-minutes` budget',
    })
  })

  it('leaves a step that finishes inside its budget alone', async () => {
    const { store, advance, host } = await startScriptRun(scriptDef({ 'timeout-minutes': 1 }))

    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 2 })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')
    expect(store.getState().run.state!.steps[SCRIPT_KEY].status).toBe('succeeded')

    // Well past the deadline: the timer is gone, and nothing re-fails the row.
    await advance(120_000)
    await flush()
    expect(store.getState().run.state!.steps[SCRIPT_KEY].status).toBe('succeeded')
  })
})

describe('script steps — cancel', () => {
  it('cancels the running step and aborts the module', async () => {
    const { store, host, runId } = await startScriptRun()

    await store.dispatch(cancelRun())
    await flush()

    expect(host.runs[0].signal.aborted).toBe(true)
    expect(store.getState().run.state!.steps[SCRIPT_KEY].status).toBe('cancelled')
    expect(store.getState().run.state!.status).toBe('cancelled')
    expect(stepRow(runId)!.status).toBe('cancelled')
  })
})

describe('script steps — lease loss', () => {
  it('stops the module but leaves the row exactly as it was', async () => {
    // The same rule the island pane keeps (apps#370): readonly means "not
    // ours to drive", not "cancelled". `scopedDispatch` would *not* catch a
    // stray event here — the run's own status is still `running` — so the
    // launcher has to stay silent on an abort it did not cause.
    const { store, advance, host, runId } = await startScriptRun()
    server.use(
      http.post('/api/workflow/run/lease', () =>
        HttpResponse.json({ ok: false, heldBy: 'tab_other' }),
      ),
    )

    await pumpUntil(advance, () => store.getState().run.mode === 'readonly', {
      stepMs: 1_000,
      maxSteps: 30,
    })
    await flush()

    expect(host.runs[0].signal.aborted).toBe(true)
    expect(store.getState().run.state!.steps[SCRIPT_KEY].status).toBe('running')
    expect(stepRow(runId)!.status).toBe('running')
    expect(stepRow(runId)!.finishedAt ?? null).toBeNull()
  })

  it('leaves the row alone when the lease goes away mid-upload', async () => {
    // The upload is the one part of a script step still talking to the network
    // after the module is done. Without the step's signal on it, it would run
    // to completion and write a `succeeded` row for a run another tab now
    // owns — `scopedDispatch` cannot catch that (same run, same generation,
    // status still `running`).
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.use(
      http.put('/mock-upload/*', async () => {
        await gate
        return new HttpResponse(null, { status: 200 })
      }),
      http.post('/api/workflow/run/lease', () =>
        HttpResponse.json({ ok: false, heldBy: 'tab_other' }),
      ),
    )

    const { store, advance, host, runId } = await startScriptRun()
    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 3 })
    await flush()

    await pumpUntil(advance, () => store.getState().run.mode === 'readonly', {
      stepMs: 1_000,
      maxSteps: 30,
    })
    // Whether or not the PUT ever answers, nothing more may be written.
    release()
    await flush(30)

    expect(host.runs[0].signal.aborted).toBe(true)
    expect(store.getState().run.state!.steps[SCRIPT_KEY].status).toBe('running')
    expect(stepRow(runId)!.status).toBe('running')
    expect(stepRow(runId)!.outputs ?? null).toBeNull()
    expect(stepRow(runId)!.error ?? null).toBeNull()
  })
})

describe('script steps — a throwing `summary:` template', () => {
  /**
   * `succeededEvent` evaluates the step's own author-written templates. One
   * bad expression used to throw out of the launcher's floating async
   * function: no event, no unhandled-rejection handler, the step stuck
   * `running` and the run never finishing. Both flavours of throw are checked
   * because they map to *different* codes — the same two the pipeline adapter
   * records for the same two throws (`toStepError`), bar the catch-all, which
   * is `SCRIPT` for a script where it is `STEP` for a pipeline (03).
   */
  async function failedWith(summary: string) {
    const { store, advance, host } = await startScriptRun(scriptDef({ summary }))
    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 3 })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')
    return { step: store.getState().run.state!.steps[SCRIPT_KEY], store }
  }

  it('fails EXPRESSION on a template that fails to evaluate', async () => {
    const { step, store } = await failedWith('${{ unknownFn() }}')

    expect(step.status).toBe('failed')
    expect(step.error?.code).toBe('EXPRESSION')
    expect(step.error?.message).toContain('unknownFn')
    expect(store.getState().run.state!.status).toBe('failed')
  })

  it('fails SCRIPT on a template that fails to parse, rather than stalling the run', async () => {
    const { step, store } = await failedWith('${{ steps.poster.outputs.count == }}')

    expect(step.status).toBe('failed')
    expect(step.error?.code).toBe('SCRIPT')
    expect(store.getState().run.state!.status).toBe('failed')
  })
})

describe('script steps — resume (Decision 13)', () => {
  /** A run row + step rows for a run whose script was left `running`. */
  function runningRows(runId: string): { run: RunRow; steps: StepRow[] } {
    const def = scriptDef()
    return {
      run: {
        runId,
        impl: 'hello',
        workflow: 'interactive',
        workflowName: 'Scripted',
        definition: def.raw,
        yaml: SCRIPT_YAML,
        inputs: { label: 'Hi' },
        status: 'running',
        headless: false,
        startedAt: 1_000,
        finishedAt: null,
        outputs: null,
        annotations: [],
      },
      steps: [
        {
          runId,
          key: SCRIPT_KEY,
          job: 'make',
          index: 0,
          step: 'poster',
          kind: 'script',
          status: 'running',
          attempt: 1,
          inputs: { label: 'Hi' },
          annotations: [],
          startedAt: 1_001,
        },
      ],
    }
  }

  it('relaunches a running script exactly once and lets it finish', async () => {
    const { store, advance, host } = scriptStore()
    const def = scriptDef()
    const runId = 'run_resumed_script'
    const { run, steps } = runningRows(runId)

    store.dispatch(runOpened({ meta: { def, yaml: SCRIPT_YAML, workflowName: 'Scripted' } }))
    store.dispatch(runReplaced({ state: replayRun(run, steps, def), mode: 'live' }))
    await flush()

    // From scratch, like a `running` pipeline row — one run, not two.
    expect(host.runs).toHaveLength(1)
    expect(host.runs[0].inputs).toEqual({ label: 'Hi' })

    host.settle({ poster: new Blob(['<svg/>'], { type: 'image/svg+xml' }), count: 4 })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    expect(host.runs).toHaveLength(1)
    expect(store.getState().run.state!.steps[SCRIPT_KEY].status).toBe('succeeded')
    expect(store.getState().run.state!.steps[SCRIPT_KEY].outputs!.count).toBe(4)
  })

  it('replay puts the recorded `log` tail back on a finished step (apps#527)', () => {
    const def = scriptDef()
    const runId = 'run_readback_log'
    const { run, steps } = runningRows(runId)
    const finished: StepRow[] = [
      {
        ...steps[0],
        status: 'succeeded',
        outputs: { count: 2 },
        log: ['frame 1', 'frame 2'],
        finishedAt: 1_002,
      },
    ]

    const state = replayRun({ ...run, status: 'succeeded', finishedAt: 1_003 }, finished, def)

    expect(state.steps[SCRIPT_KEY].status).toBe('succeeded')
    expect(state.steps[SCRIPT_KEY].log).toEqual(['frame 1', 'frame 2'])
  })
})
