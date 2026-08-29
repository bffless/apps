/**
 * Task 5's shared support for driving an `island` step through the real runner
 * middleware with a **fake `IslandHost`** injected through
 * `RunnerDeps.islandHost`.
 *
 * The island protocol itself is proven in `islands/IslandHost.test.ts` against
 * the real ext-apps `App`; what these tests care about is the *wiring* — which
 * events the middleware emits around a mount, who tears the host down, and
 * what the pane finds when it looks its handle up. So the host here is a
 * hand-written double whose `mount` stays pending until the test settles it,
 * which is the only way to observe the `running → waiting` seam at all.
 *
 * Not a `*.test.ts` file itself (vitest's `include` only matches `.test`/
 * `.spec`), so this never runs as its own suite.
 */
import { toDefinition } from '@bffless/workflow-lint/definition'
import { IslandMountAbandoned } from '../islands/IslandHost'
import type { IslandDisplayMode, IslandHost, IslandHostDeps, IslandMountArgs } from '../islands/IslandHost'
import { httpJson } from '../lib/http'
import { loadWorkflow } from '../lib/runner/definition'
import type { HttpJson } from '../lib/runner/adapters/pipeline'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, FileRef, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { RunStore } from '../lib/runStore'
import { createRunStore } from '../lib/runStore'
import type { AppStore } from '../store'
import { makeStore } from '../store'
import type { RunnerDeps } from '../store/runnerMiddleware'
import { createRegisterFile, runnerControllers } from '../store/runnerMiddleware'
import { startRun } from '../store/runnerActions'
import { runClosed } from '../store/runSlice'
import { pumpUntil, virtualClock } from './helloHarness'
import interactiveYaml from '../../docs/spec/examples/interactive.workflow.yaml?raw'

export { flush, pumpUntil, virtualClock } from './helloHarness'

// ---------------------------------------------------------------------------
// A one-job workflow whose only step is an island
// ---------------------------------------------------------------------------

export const ISLAND_YAML = 'name: Island\n'

export const ISLAND_DEF = toDefinition({
  name: 'Island',
  jobs: {
    a: {
      steps: [
        {
          id: 'pick',
          uses: 'island',
          with: { src: 'islands/pick.html', title: 'Pick one', mode: 'quick' },
          outputs: { choice: { type: 'string' } },
        },
      ],
      outputs: { choice: '${{ steps.pick.outputs.choice }}' },
    },
  },
  outputs: { choice: '${{ jobs.a.outputs.choice }}' },
}) as Definition

export const ISLAND_KEY: StepKey = stepKey('a', 0, 'pick')

/** The same workflow, but its island declares `headless: auto` (07) — the shape Accept is offered on. */
export const ISLAND_AUTO_DEF = toDefinition({
  name: 'Island',
  jobs: {
    a: {
      steps: [
        {
          id: 'pick',
          uses: 'island',
          with: { src: 'islands/pick.html', title: 'Pick one', mode: 'quick' },
          outputs: { choice: { type: 'string' } },
          headless: 'auto',
        },
      ],
      outputs: { choice: '${{ steps.pick.outputs.choice }}' },
    },
  },
  outputs: { choice: '${{ jobs.a.outputs.choice }}' },
}) as Definition

/** The same workflow, but its island declares `display: fullscreen` (04). */
export const ISLAND_FULLSCREEN_DEF = toDefinition({
  name: 'Island',
  jobs: {
    a: {
      steps: [
        {
          id: 'pick',
          uses: 'island',
          with: {
            src: 'islands/pick.html',
            title: 'Pick one',
            display: 'fullscreen',
            mode: 'quick',
          },
          outputs: { choice: { type: 'string' } },
        },
      ],
      outputs: { choice: '${{ steps.pick.outputs.choice }}' },
    },
  },
  outputs: { choice: '${{ jobs.a.outputs.choice }}' },
}) as Definition

/**
 * A waiting form and a loading island **side by side**: two layer-0 jobs, so
 * the run reaches both at once. The one shape that makes "an island must not
 * take the pane from a person mid-interaction" observable (fix round 4,
 * finding 1).
 */
export const FORM_AND_ISLAND_DEF = toDefinition({
  name: 'Island',
  jobs: {
    ask: {
      steps: [
        {
          id: 'confirm',
          uses: 'form',
          with: {
            title: 'Does this look right?',
            fields: { approved: { type: 'boolean', default: true } },
            submit: 'Finish',
          },
        },
      ],
    },
    pick: {
      steps: [
        {
          id: 'choose',
          uses: 'island',
          with: { src: 'islands/pick.html', title: 'Pick one', mode: 'quick' },
          outputs: { choice: { type: 'string' } },
        },
      ],
    },
  },
}) as Definition

export const FORM_KEY: StepKey = stepKey('ask', 0, 'confirm')
export const PARALLEL_ISLAND_KEY: StepKey = stepKey('pick', 0, 'choose')

/**
 * A waiting form beside two parallel jobs of islands: `a` = `x` then `y`,
 * `b` = `z`. The form owns the pane (it is `waiting`, and waiting wins), so
 * the islands load unclaimed; the scheduler starts `a/x` and `b/z` together
 * and `a/y` only after `a/x` submits — so the run state holds `b/z` *before*
 * `a/y`, while scheduling order (topo, then job id) puts `a/y` first. The one
 * shape where "which loading island opens" can distinguish insertion order
 * from scheduling order (apps#370).
 */
const islandStep = (id: string) => ({
  id,
  uses: 'island',
  with: { src: `islands/${id}.html`, title: id, mode: 'quick' },
  outputs: { choice: { type: 'string' } },
})

export const FORM_AND_TWO_ISLANDS_DEF = toDefinition({
  name: 'Island',
  jobs: {
    ask: {
      steps: [
        {
          id: 'confirm',
          uses: 'form',
          with: {
            title: 'Does this look right?',
            fields: { approved: { type: 'boolean', default: true } },
            submit: 'Finish',
          },
        },
      ],
    },
    a: { steps: [islandStep('x'), islandStep('y')] },
    b: { steps: [islandStep('z')] },
  },
}) as Definition

export const A_X_KEY: StepKey = stepKey('a', 0, 'x')
export const A_Y_KEY: StepKey = stepKey('a', 0, 'y')
export const B_Z_KEY: StepKey = stepKey('b', 0, 'z')

// ---------------------------------------------------------------------------
// The M2 interactive workflow — a real pipeline step *and* an island step
// ---------------------------------------------------------------------------

export const INTERACTIVE_YAML = interactiveYaml
export const interactive = loadWorkflow(
  interactiveYaml,
  'interactive.workflow.yaml',
).def as Definition
export const SAY_KEY: StepKey = stepKey('greet', 0, 'say')
export const CHOOSE_KEY: StepKey = stepKey('pick', 0, 'choose')

// ---------------------------------------------------------------------------
// The fake host
// ---------------------------------------------------------------------------

export interface FakeIslandHost {
  /** Pass as `RunnerDeps.islandHost`. */
  factory: (deps: IslandHostDeps) => IslandHost
  /** The deps the middleware built the *latest* host with — `onSubmit`/`onAnnotate` live here. */
  deps: IslandHostDeps | null
  /** The deps of every host built, in launch order — for runs with more than one island. */
  allDeps: IslandHostDeps[]
  /** Every `mount` the handle made, in order. */
  mounts: IslandMountArgs[]
  frames: HTMLIFrameElement[]
  teardowns: string[]
  displayModes: IslandDisplayMode[]
  /** Every `setHeadless` the page made (Accept, apps#432), in order. */
  headlessChanges: boolean[]
  /** Resolve the oldest pending mount (the island finished `ui/initialize`). */
  settle(): void
  /** Reject the oldest pending mount (an `ISLAND_LOAD`). */
  fail(err: Error): void
  pending(): number
}

/**
 * A hand-written `IslandHost`, faithful on the one behaviour the middleware's
 * wiring turns on: like the real host, `teardown` and a superseding `mount`
 * **abandon** any mount still in flight (`IslandMountAbandoned`) rather than
 * leaving it pending or failing it. Without that, the StrictMode double-mount
 * and navigate-away-mid-load paths could not be exercised at all.
 */
export function fakeIslandHost(): FakeIslandHost {
  const settlers: { resolve: () => void; reject: (err: Error) => void }[] = []

  const abandonPending = (why: string) => {
    while (settlers.length > 0) settlers.shift()!.reject(new IslandMountAbandoned(why))
  }

  const fake: FakeIslandHost = {
    deps: null,
    allDeps: [],
    mounts: [],
    frames: [],
    teardowns: [],
    displayModes: [],
    headlessChanges: [],
    pending: () => settlers.length,
    settle() {
      const next = settlers.shift()
      if (!next) throw new Error('fakeIslandHost: no pending mount to settle')
      next.resolve()
    },
    fail(err) {
      const next = settlers.shift()
      if (!next) throw new Error('fakeIslandHost: no pending mount to fail')
      next.reject(err)
    },
    factory: (deps) => {
      fake.deps = deps
      fake.allDeps.push(deps)
      return {
        mount(iframe, a) {
          // A second mount supersedes the first, exactly as the real host does.
          abandonPending('superseded by a second mount')
          fake.mounts.push(a)
          fake.frames.push(iframe)
          return new Promise<void>((resolve, reject) => {
            if (a.signal.aborted) {
              reject(new IslandMountAbandoned('the step went away while loading'))
              return
            }
            settlers.push({ resolve, reject })
          })
        },
        setDisplayMode(mode) {
          fake.displayModes.push(mode)
        },
        setHeadless(headless) {
          fake.headlessChanges.push(headless)
        },
        async sendToolInput() {
          // A step's island is never re-sent tool-input (apps#370); the pane's
          // adapter only ever reaches this for a viewer, which no step is.
          throw new Error('fakeIslandHost: sendToolInput is not expected on a step island')
        },
        async teardown(reason) {
          fake.teardowns.push(reason)
          abandonPending(`torn down (${reason}) while loading`)
        },
      }
    },
  }

  return fake
}

// ---------------------------------------------------------------------------
// A store wired to it
// ---------------------------------------------------------------------------

type Recorded =
  | { op: 'create'; row: RunRow }
  | { op: 'patch'; id: string; patch: Partial<RunRow> }
  | { op: 'upsert'; runId: string; key: StepKey; patch: Partial<StepRow> }

type LeaseAnswer = { ok: boolean; leaseUntil?: number; heldBy?: string }

/**
 * An in-memory `RunStore` that records every write and never fails. `setLease`
 * flips what the next heartbeats hear — `{ ok: false }` is a lost lease.
 */
export function memoryRunStore(): {
  store: RunStore
  writes: Recorded[]
  setLease: (answer: LeaseAnswer) => void
} {
  const writes: Recorded[] = []
  let lease: LeaseAnswer = { ok: true, leaseUntil: Date.now() + 60_000 }
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
      return lease
    },
  }
  return { store, writes, setLease: (answer) => (lease = answer) }
}

const noHttp: HttpJson = async (path) => {
  throw new Error(`islandHarness: unexpected HTTP call to ${path}`)
}

const noRegisterFile = async (): Promise<FileRef> => {
  throw new Error('islandHarness: registerFile is not exercised by island steps')
}

const trackedStores: AppStore[] = []

export interface IslandRun {
  store: AppStore
  advance: (ms: number) => Promise<void>
  runId: string
  host: FakeIslandHost
  writes: Recorded[]
  /** What the run store answers the next heartbeats with. */
  setLease: (answer: LeaseAnswer) => void
}

/** Builds a store around a fresh fake host, without starting anything. */
export function islandStore(): Omit<IslandRun, 'runId'> {
  const host = fakeIslandHost()
  const { clock, advance } = virtualClock()
  const { store: runStore, writes, setLease } = memoryRunStore()
  const deps: RunnerDeps = {
    http: noHttp,
    clock,
    runStore,
    registerFile: noRegisterFile,
    islandHost: host.factory,
  }
  const store = makeStore(deps)
  trackedStores.push(store)
  return { store, advance, host, writes, setLease }
}

/**
 * Starts `ISLAND_DEF` and pumps until the island step is `running` — i.e. the
 * middleware has registered the handle and the pane could mount it, but the
 * mount has not settled yet (Decision 11's `running → waiting` seam).
 */
export async function startIslandRun(
  def: Definition = ISLAND_DEF,
  islandKey: StepKey = ISLAND_KEY,
): Promise<IslandRun> {
  const { store, advance, host, writes, setLease } = islandStore()
  store.dispatch(
    startRun({
      impl: 'test',
      workflow: 'island',
      def,
      yaml: ISLAND_YAML,
      workflowName: 'Island',
      values: {},
    }),
  )

  await pumpUntil(advance, () => store.getState().run.state?.steps[islandKey]?.status === 'running')

  return { store, advance, host, writes, setLease, runId: store.getState().run.state!.runId }
}

/**
 * The M2 `interactive` workflow (docs/spec/examples) against the **real** MSW
 * backend — its `greet`/`analyze` jobs are pipelines — with the fake island
 * host injected for `pick/0/choose`. The only harness where a run holds both a
 * non-island step the user can click and an island step that starts later.
 *
 * Pumped only as far as `greet/0/say` existing: the island is still several
 * jobs away, which is what lets a test select something else first.
 */
export async function startInteractiveRun(): Promise<{
  store: AppStore
  advance: (ms: number) => Promise<void>
  host: FakeIslandHost
  runId: string
}> {
  const host = fakeIslandHost()
  const { clock, advance } = virtualClock()
  const deps: RunnerDeps = {
    http: httpJson,
    clock,
    runStore: createRunStore(httpJson),
    registerFile: createRegisterFile(httpJson),
    islandHost: host.factory,
  }
  const store = makeStore(deps)
  trackedStores.push(store)

  store.dispatch(
    startRun({
      impl: 'hello',
      workflow: 'interactive',
      def: interactive,
      yaml: INTERACTIVE_YAML,
      workflowName: 'Interactive hello',
      values: { greeting: 'Hello', names: ['world', 'studio'] },
    }),
  )

  await pumpUntil(advance, () => store.getState().run.state?.steps[SAY_KEY] !== undefined)

  return { store, advance, host, runId: store.getState().run.state!.runId }
}

/** Call from `afterEach`: closes every store this module tracked (the runner singletons are global). */
export function resetIslandHarness(): void {
  for (const store of trackedStores) store.dispatch(runClosed())
  runnerControllers.abortAll()
  trackedStores.length = 0
}
