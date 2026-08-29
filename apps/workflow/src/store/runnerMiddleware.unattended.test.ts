/**
 * "Don't wait for me" (07, apps#432): an **interactive** run that honours every
 * step's `headless:` declaration exactly as a headless run does — `auto`
 * self-submits, `skip` stands its declared outputs in — with the one difference
 * that a step declaring neither still waits for the person, who is there.
 *
 * Same harness as `runnerMiddleware.headless.test.ts` (the real middleware,
 * the MSW-backed run store, a virtual clock), but `run.started` carries
 * `unattended: true` and `headless: false`: the two are separate facts on the
 * row, and this suite is what keeps them apart.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { toDefinition } from '@bffless/workflow-lint/definition'
import { newRunId } from '../lib/runner/ids'
import type { Definition, RunState, StepKey, StepState } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { AppStore } from './index'
import {
  HELLO_YAML,
  REVIEW_KEY,
  flush,
  hello,
  pumpUntil,
  resetHelloHarness,
  trackedHelloStore,
} from '../test/helloHarness'
import { ISLAND_KEY, ISLAND_YAML, islandStore, resetIslandHarness } from '../test/islandHarness'
import { getIslandHandle } from './islandLaunch'
import { startRun } from './runnerActions'
import { runEvent, runOpened } from './runSlice'

afterEach(() => {
  resetHelloHarness()
  resetIslandHarness()
})

const YAML = '# an unattended workflow\n'
const REVIEW: StepKey = stepKey('confirm', 0, 'review')

function withSteps(steps: Record<string, unknown>[]): Definition {
  return toDefinition({ name: 'Unattended', jobs: { confirm: { steps } } }) as Definition
}

function form(fields: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: 'review', uses: 'form', with: { title: 'Review', fields, submit: 'Approve' }, ...extra }
}

interface Started {
  store: AppStore
  advance: (ms: number) => Promise<void>
}

/** `unattended` on `run.started`, `headless` off — the kickoff form's own start. */
async function start(def: Definition, a: { unattended?: boolean } = {}): Promise<Started> {
  const { store, advance } = trackedHelloStore()
  store.dispatch(runOpened({ meta: { def, yaml: YAML, workflowName: 'Unattended' } }))
  store.dispatch(
    runEvent({
      type: 'run.started',
      runId: newRunId(),
      impl: 'hello',
      workflow: 'unattended',
      inputs: {},
      headless: false,
      unattended: a.unattended ?? true,
      at: 1_000,
    }),
  )
  await flush()
  return { store, advance }
}

const runState = (store: AppStore): RunState => store.getState().run.state!
const stepOf = (store: AppStore, key: StepKey = REVIEW): StepState | undefined => runState(store).steps[key]

const TERMINAL = ['succeeded', 'failed', 'skipped', 'cancelled']

async function settle(s: Started, key: StepKey = REVIEW): Promise<void> {
  await pumpUntil(s.advance, () => TERMINAL.includes(s.store.getState().run.state?.steps[key]?.status ?? ''))
}

describe('unattended — the declarations a headless run honours', () => {
  it('skips a `skip` form with its declared outputs', async () => {
    const def = withSteps([
      form({ approved: { type: 'boolean' } }, { headless: { mode: 'skip', outputs: { approved: true } } }),
    ])
    const s = await start(def)
    await settle(s)

    expect(stepOf(s.store)!).toMatchObject({ status: 'skipped', outputs: { approved: true } })
    expect(runState(s.store)).toMatchObject({ headless: false, unattended: true })
  })

  it("submits an `auto` form's defaults by itself", async () => {
    const def = withSteps([
      form({ approved: { type: 'boolean', default: true }, note: { type: 'string', default: 'ok' } }, { headless: 'auto' }),
    ])
    const s = await start(def)
    await settle(s)

    expect(stepOf(s.store)!).toMatchObject({ status: 'succeeded', outputs: { approved: true, note: 'ok' } })
  })

  it('still waits on a form that declared nothing — never HEADLESS_REQUIRED', async () => {
    // The difference from a headless run: the person is there, so an
    // undeclared step is theirs to answer, not a definition that cannot run.
    const def = withSteps([form({ approved: { type: 'boolean', default: true } })])
    const s = await start(def)
    await pumpUntil(s.advance, () => stepOf(s.store)?.status === 'waiting')
    await s.advance(10 * 60_000)

    expect(stepOf(s.store)!.status).toBe('waiting')
    expect(stepOf(s.store)!.error).toBeUndefined()
    expect(runState(s.store).status).toBe('running')
    expect(runState(s.store).annotations).toEqual([])
  })

  it('leaves an ordinary interactive run exactly as it was', async () => {
    const def = withSteps([
      form({ approved: { type: 'boolean' } }, { headless: { mode: 'skip', outputs: { approved: true } } }),
    ])
    const s = await start(def, { unattended: false })
    await pumpUntil(s.advance, () => stepOf(s.store)?.status === 'waiting')

    expect(stepOf(s.store)!.status).toBe('waiting')
  })
})

describe('unattended — the hello workflow end to end', () => {
  /** Start `hello` from the kickoff path and pump until the run settles. */
  async function runHello(a: { headless?: boolean; unattended?: boolean }): Promise<RunState> {
    const { store, advance } = trackedHelloStore()
    store.dispatch(
      startRun({
        impl: 'hello',
        workflow: 'hello',
        def: hello,
        yaml: HELLO_YAML,
        workflowName: 'Hello workflow',
        values: { greeting: 'Hello', names: ['world', 'studio'], photo: null, shout: false },
        ...a,
      }),
    )
    await pumpUntil(advance, () => store.getState().run.state?.status !== 'running', { maxSteps: 600 })
    return runState(store)
  }

  it('completes with no human step, producing the same outputs as a headless run of the same inputs', async () => {
    const unattended = await runHello({ unattended: true })
    const headless = await runHello({ headless: true })

    expect(unattended.status).toBe('succeeded')
    expect(unattended.steps[REVIEW_KEY]!.status).toBe('skipped')
    expect(unattended).toMatchObject({ headless: false, unattended: true })
    expect(headless).toMatchObject({ headless: true, unattended: false })

    // The one place the two runs may differ is the ids baked into File refs.
    const comparable = (state: RunState) => JSON.stringify(state.outputs).replaceAll(state.runId, 'run')
    expect(comparable(unattended)).toBe(comparable(headless))
  })
})

describe('unattended — islands', () => {
  const islandDef = (extra: Record<string, unknown>) =>
    toDefinition({
      name: 'Island',
      jobs: {
        a: {
          steps: [
            {
              id: 'pick',
              uses: 'island',
              with: { src: 'islands/pick.html', title: 'Pick one', mode: 'quick' },
              outputs: { choice: { type: 'string' } },
              ...extra,
            },
          ],
        },
      },
    }) as Definition

  async function launch(def: Definition, unattended: boolean) {
    const { store, advance, writes } = islandStore()
    store.dispatch(
      startRun({ impl: 'test', workflow: 'island', def, yaml: ISLAND_YAML, workflowName: 'Island', values: {}, unattended }),
    )
    await pumpUntil(advance, () => store.getState().run.state?.steps[ISLAND_KEY]?.status === 'running')
    const runId = store.getState().run.state!.runId
    return { store, writes, handle: getIslandHandle(runId, ISLAND_KEY)! }
  }

  it('tells a `headless: auto` island it is driving itself, and records `unattended` on the run row', async () => {
    const { handle, writes } = await launch(islandDef({ headless: 'auto' }), true)

    // The island reads one flag — `hostContext.bffless.headless` — and cannot
    // tell an unattended run from a headless one; no island change (07).
    expect(handle.headless).toBe(true)

    const create = writes.find((w) => w.op === 'create')
    expect(create && create.op === 'create' ? create.row : null).toMatchObject({ headless: false, unattended: true })
  })

  it('leaves an undeclared island to its person, and an attended `auto` island alone', async () => {
    const undeclared = await launch(islandDef({}), true)
    expect(undeclared.handle.headless).toBe(false)
    expect(undeclared.store.getState().run.state!.steps[ISLAND_KEY]!.status).toBe('running')
    resetIslandHarness()

    const attended = await launch(islandDef({ headless: 'auto' }), false)
    expect(attended.handle.headless).toBe(false)
  })
})
