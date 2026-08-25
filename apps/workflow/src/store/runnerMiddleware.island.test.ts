/**
 * The `island` step, in the middleware (Task 5, Decisions 11 & 12).
 *
 * The middleware cannot create DOM, so it does not mount anything itself: it
 * evaluates the step's `with`, records the tool `arguments` as the step's
 * `inputs`, builds an `IslandHost` and parks a **handle** where the pane can
 * find it. Everything observable from here is that handle plus the events the
 * handle's own `mount` promise produces — `waiting` when the island came up,
 * `ISLAND_LOAD` when it did not — so these tests drive the handle directly and
 * leave the iframe to `IslandStepPane.test.tsx`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { IslandLoadError, IslandMountAbandoned } from '../islands/IslandHost'
import { replayRun } from '../lib/runner/replay'
import type { RunRow, StepRow } from '../lib/runner/rows'
import { getIslandHandle } from './islandLaunch'
import { cancelRun } from './lifecycleActions'
import { runOpened, runReplaced } from './runSlice'
import {
  ISLAND_DEF,
  ISLAND_FULLSCREEN_DEF,
  ISLAND_KEY,
  ISLAND_YAML,
  flush,
  islandStore,
  pumpUntil,
  resetIslandHarness,
  startIslandRun,
} from '../test/islandHarness'

afterEach(() => {
  resetIslandHarness()
})

/** A detached iframe is all the fake host ever does with the element. */
function frame(): HTMLIFrameElement {
  return document.createElement('iframe')
}

describe('island steps — launch', () => {
  it('records the tool arguments as the step inputs and parks a handle for the pane', async () => {
    const { store, runId, host } = await startIslandRun()

    const step = store.getState().run.state!.steps[ISLAND_KEY]
    expect(step.status).toBe('running')
    // `src`/`title`/`display` configure the frame; they are not tool input.
    expect(step.inputs).toEqual({ mode: 'quick' })

    const handle = getIslandHandle(runId, ISLAND_KEY)
    expect(handle).toBeDefined()
    expect(handle!.title).toBe('Pick one')
    expect(handle!.src).toBe('islands/pick.html')
    expect(handle!.display).toBe('inline')
    expect(handle!.arguments).toEqual({ mode: 'quick' })

    // Nothing has been mounted yet — the pane owns the element.
    expect(host.mounts).toHaveLength(0)
  })

  it('moves the step to waiting once the handle mount resolves', async () => {
    const { store, runId, host } = await startIslandRun()

    const iframe = frame()
    void getIslandHandle(runId, ISLAND_KEY)!.mount(iframe)
    await flush()

    expect(host.mounts).toHaveLength(1)
    expect(host.frames[0]).toBe(iframe)
    expect(host.mounts[0].impl).toBe('test')
    expect(host.mounts[0].src).toBe('islands/pick.html')
    expect(host.mounts[0].arguments).toEqual({ mode: 'quick' })
    expect(host.mounts[0].headless).toBe(false)
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('running')

    host.settle()
    await flush()

    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting')
  })

  it('fails the step ISLAND_LOAD when the mount rejects', async () => {
    const { store, runId, host, advance } = await startIslandRun()

    void getIslandHandle(runId, ISLAND_KEY)!.mount(frame())
    await flush()
    host.fail(new IslandLoadError('island /w/test/islands/pick.html: failed with status 404'))

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[ISLAND_KEY]
    expect(step.status).toBe('failed')
    expect(step.error?.code).toBe('ISLAND_LOAD')
    expect(step.error?.message).toContain('status 404')
    expect(store.getState().run.state!.status).toBe('failed')
    // A failed step's host is torn down, and its handle goes with it.
    expect(host.teardowns).toContain('completed')
    expect(getIslandHandle(store.getState().run.state!.runId, ISLAND_KEY)).toBeUndefined()
  })
})

describe('island steps — an abandoned mount is not a failure', () => {
  it('leaves the step running when the mount is abandoned rather than failed', async () => {
    // The dev-mode reality this guards (fix round 1, finding 1): React
    // StrictMode double-mounts every effect, so session 1 is *always*
    // superseded — recording that as ISLAND_LOAD would fail every island on
    // its first load before the user saw anything.
    const { store, runId, host } = await startIslandRun()

    void getIslandHandle(runId, ISLAND_KEY)!.mount(frame())
    await flush()
    host.fail(new IslandMountAbandoned('island /w/test/islands/pick.html: superseded'))
    await flush()

    const step = store.getState().run.state!.steps[ISLAND_KEY]
    expect(step.status).toBe('running')
    expect(step.error).toBeUndefined()
    expect(store.getState().run.state!.status).toBe('running')
    // The handle survives: the step is still live, and the next mount is the
    // one that counts.
    expect(getIslandHandle(runId, ISLAND_KEY)).toBeDefined()
  })

  it('reaches waiting exactly once across a superseding second mount', async () => {
    const { store, runId, host } = await startIslandRun()
    const handle = getIslandHandle(runId, ISLAND_KEY)!

    // Mount, then mount again before the first settles — the fake abandons the
    // first, exactly as `IslandHost` does.
    void handle.mount(frame())
    await flush()
    void handle.mount(frame())
    await flush()
    expect(host.mounts).toHaveLength(2)

    host.settle()
    await flush()

    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting')
    expect(store.getState().run.state!.steps[ISLAND_KEY].error).toBeUndefined()
  })
})

describe('island steps — the host tools', () => {
  it('workflow.submit validates against the declared outputs and finishes the run', async () => {
    const { store, runId, host, advance } = await startIslandRun()

    void getIslandHandle(runId, ISLAND_KEY)!.mount(frame())
    await flush()
    host.settle()
    await flush()

    // A submit that does not match the declaration comes back as per-output
    // errors — never an event.
    expect(host.deps!.onSubmit({ choice: 42 })).toEqual({
      ok: false,
      errors: { choice: expect.any(String) },
    })
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting')

    expect(host.deps!.onSubmit({ choice: 'a', extra: 'dropped' })).toEqual({ ok: true })
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')

    const step = store.getState().run.state!.steps[ISLAND_KEY]
    expect(step.status).toBe('succeeded')
    expect(step.outputs).toEqual({ choice: 'a' })
    expect(store.getState().run.state!.status).toBe('succeeded')
    expect(store.getState().run.state!.outputs).toEqual({ choice: 'a' })

    expect(host.teardowns).toEqual(['completed'])
    expect(getIslandHandle(runId, ISLAND_KEY)).toBeUndefined()
  })

  it('refuses a second submit instead of throwing an illegal transition', async () => {
    // The bridge is closed a persist round-trip *after* the step goes terminal,
    // so an impatient island can submit twice (fix round 1, finding 3).
    const { store, runId, host, advance } = await startIslandRun()

    void getIslandHandle(runId, ISLAND_KEY)!.mount(frame())
    await flush()
    host.settle()
    await flush()

    expect(host.deps!.onSubmit({ choice: 'a' })).toEqual({ ok: true })
    const second = host.deps!.onSubmit({ choice: 'b' })
    expect(second).toEqual({ ok: false, errors: { outputs: expect.any(String) } })
    // And annotating a step that has already answered is refused the same way.
    expect(host.deps!.onAnnotate({ summary: 'too late' })).toEqual({
      ok: false,
      error: expect.any(String),
    })

    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running')
    const step = store.getState().run.state!.steps[ISLAND_KEY]
    expect(step.status).toBe('succeeded')
    expect(step.outputs).toEqual({ choice: 'a' })
    expect(step.summary).toBeUndefined()
  })

  it('workflow.annotate lands as step.annotated on the still-waiting step', async () => {
    const { store, runId, host } = await startIslandRun()

    void getIslandHandle(runId, ISLAND_KEY)!.mount(frame())
    await flush()
    host.settle()
    await flush()

    expect(host.deps!.onAnnotate({ nope: true })).toEqual({ ok: false, error: expect.any(String) })

    expect(
      host.deps!.onAnnotate({
        summary: 'Half way',
        annotations: [{ level: 'notice', message: 'picked twice' }],
      }),
    ).toEqual({ ok: true })
    await flush()

    const step = store.getState().run.state!.steps[ISLAND_KEY]
    expect(step.status).toBe('waiting')
    expect(step.summary).toBe('Half way')
    expect(step.annotations).toEqual([{ level: 'notice', message: 'picked twice' }])
  })

  it('ui/message lines land on the handle log', async () => {
    const { runId, host } = await startIslandRun()

    const handle = getIslandHandle(runId, ISLAND_KEY)!
    void handle.mount(frame())
    await flush()
    host.settle()
    await flush()

    const before = handle.log
    host.deps!.onLog('rendered 3 clips')
    expect(handle.log).toEqual(['rendered 3 clips'])
    // A fresh array each line: the pane reads `log` as an immutable snapshot
    // (apps#370), so the handle itself never has to change identity.
    expect(handle.log).not.toBe(before)
    expect(before).toEqual([])
  })

  it('ui/request-display-mode drives the ui slice, but launching alone never does', async () => {
    const { store, runId, host } = await startIslandRun()

    void getIslandHandle(runId, ISLAND_KEY)!.mount(frame())
    await flush()
    host.settle()
    await flush()

    expect(store.getState().ui.islandDisplay).toBe('inline')
    host.deps!.onDisplayMode('fullscreen')
    expect(store.getState().ui.islandDisplay).toBe('fullscreen')
  })

  it('does not seed the page mode at launch, even for a declared fullscreen island', async () => {
    // Fix round 1, finding 4: launching is global, so a second island starting
    // in a parallel job must not drag the page out from under the first. The
    // declared mode is applied by the page when it opens the pane.
    const { store } = await startIslandRun(ISLAND_FULLSCREEN_DEF)
    expect(store.getState().ui.islandDisplay).toBe('inline')
  })
})

describe('island steps — cancel', () => {
  it('tears the host down as cancelled and cancels the waiting step', async () => {
    const { store, runId, host } = await startIslandRun()

    void getIslandHandle(runId, ISLAND_KEY)!.mount(frame())
    await flush()
    host.settle()
    await flush()
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting')

    await store.dispatch(cancelRun())
    await flush()

    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('cancelled')
    expect(store.getState().run.state!.status).toBe('cancelled')
    expect(host.teardowns).toEqual(['cancelled'])
    expect(getIslandHandle(runId, ISLAND_KEY)).toBeUndefined()
  })
})

describe('island steps — resume (Decision 11)', () => {
  /** A run row + step rows for a run whose island was left `waiting`. */
  function waitingRows(runId: string): { run: RunRow; steps: StepRow[] } {
    return {
      run: {
        runId,
        impl: 'test',
        workflow: 'island',
        workflowName: 'Island',
        definition: ISLAND_DEF.raw,
        yaml: ISLAND_YAML,
        inputs: {},
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
          key: ISLAND_KEY,
          job: 'a',
          index: 0,
          step: 'pick',
          kind: 'island',
          status: 'waiting',
          attempt: 1,
          // The record is the truth: these are re-delivered verbatim, never
          // re-evaluated (D16, Decision 11).
          inputs: { mode: 'recorded' },
          annotations: [],
          startedAt: 1_001,
        },
      ],
    }
  }

  it('re-mounts a waiting island from its recorded inputs, without a second step.waiting', async () => {
    const { store, host } = islandStore()
    const runId = 'run_resumed'
    const { run, steps } = waitingRows(runId)

    store.dispatch(
      runOpened({ meta: { def: ISLAND_DEF, yaml: ISLAND_YAML, workflowName: 'Island' } }),
    )
    store.dispatch(runReplaced({ state: replayRun(run, steps, ISLAND_DEF), mode: 'live' }))
    await flush()

    const handle = getIslandHandle(runId, ISLAND_KEY)
    expect(handle).toBeDefined()
    expect(handle!.arguments).toEqual({ mode: 'recorded' })
    expect(handle!.title).toBe('Pick one')

    void handle!.mount(frame())
    await flush()
    host.settle()
    await flush()

    // Still `waiting` — the mount resolving must not re-dispatch `step.waiting`
    // (waiting → waiting is a no-op, but a second one would be a lie in the row
    // stream) and must certainly not throw an illegal transition.
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting')
    expect(host.mounts[0].arguments).toEqual({ mode: 'recorded' })

    // The submit path still works after a resume.
    expect(host.deps!.onSubmit({ choice: 'b' })).toEqual({ ok: true })
    await flush()
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('succeeded')
  })
})

// ---------------------------------------------------------------------------
// apps#370 — a lost lease disposes the island, not just its controller
// ---------------------------------------------------------------------------

describe('island steps — lease loss', () => {
  it('tears the host down and forgets the handle when the tab stops driving the run', async () => {
    const { store, advance, runId, host, setLease } = await startIslandRun()

    const handle = getIslandHandle(runId, ISLAND_KEY)!
    void handle.mount(frame())
    await flush()
    host.settle()
    await flush()
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting')

    setLease({ ok: false, heldBy: 'tab_other' })
    await pumpUntil(advance, () => store.getState().run.mode === 'readonly', {
      stepMs: 1_000,
      maxSteps: 30,
    })
    await flush()

    expect(getIslandHandle(runId, ISLAND_KEY)).toBeUndefined()
    // `unmounted`, not `cancelled`: the island is told the truth on the wire.
    expect(host.teardowns).toEqual(['unmounted'])
    // The record is untouched: readonly means "not ours to drive", not "cancelled".
    expect(store.getState().run.state!.steps[ISLAND_KEY].status).toBe('waiting')
  })
})
