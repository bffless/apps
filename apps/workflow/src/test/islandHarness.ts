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
import type { IslandDisplayMode, IslandHost, IslandHostDeps, IslandMountArgs } from '../islands/IslandHost'
import type { HttpJson } from '../lib/runner/adapters/pipeline'
import type { RunRow, StepRow } from '../lib/runner/rows'
import type { Definition, FileRef, StepKey } from '../lib/runner/types'
import { stepKey } from '../lib/runner/types'
import type { RunStore } from '../lib/runStore'
import type { AppStore } from '../store'
import { makeStore } from '../store'
import type { RunnerDeps } from '../store/runnerMiddleware'
import { runnerControllers } from '../store/runnerMiddleware'
import { startRun } from '../store/runnerActions'
import { runClosed } from '../store/runSlice'
import { pumpUntil, virtualClock } from './helloHarness'

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

// ---------------------------------------------------------------------------
// The fake host
// ---------------------------------------------------------------------------

export interface FakeIslandHost {
  /** Pass as `RunnerDeps.islandHost`. */
  factory: (deps: IslandHostDeps) => IslandHost
  /** The deps the middleware built the host with — `onSubmit`/`onAnnotate` live here. */
  deps: IslandHostDeps | null
  /** Every `mount` the handle made, in order. */
  mounts: IslandMountArgs[]
  frames: HTMLIFrameElement[]
  teardowns: string[]
  displayModes: IslandDisplayMode[]
  /** Resolve the oldest pending mount (the island finished `ui/initialize`). */
  settle(): void
  /** Reject the oldest pending mount (an `ISLAND_LOAD`). */
  fail(err: Error): void
  pending(): number
}

export function fakeIslandHost(): FakeIslandHost {
  const settlers: { resolve: () => void; reject: (err: Error) => void }[] = []

  const fake: FakeIslandHost = {
    deps: null,
    mounts: [],
    frames: [],
    teardowns: [],
    displayModes: [],
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
      return {
        mount(iframe, a) {
          fake.mounts.push(a)
          fake.frames.push(iframe)
          return new Promise<void>((resolve, reject) => {
            if (a.signal.aborted) {
              reject(new Error('aborted before mount'))
              return
            }
            settlers.push({ resolve, reject })
          })
        },
        setDisplayMode(mode) {
          fake.displayModes.push(mode)
        },
        async teardown(reason) {
          fake.teardowns.push(reason)
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

/** An in-memory `RunStore` that records every write and never fails. */
export function memoryRunStore(): { store: RunStore; writes: Recorded[] } {
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
}

/** Builds a store around a fresh fake host, without starting anything. */
export function islandStore(): { store: AppStore; advance: (ms: number) => Promise<void>; host: FakeIslandHost; writes: Recorded[] } {
  const host = fakeIslandHost()
  const { clock, advance } = virtualClock()
  const { store: runStore, writes } = memoryRunStore()
  const deps: RunnerDeps = {
    http: noHttp,
    clock,
    runStore,
    registerFile: noRegisterFile,
    islandHost: host.factory,
  }
  const store = makeStore(deps)
  trackedStores.push(store)
  return { store, advance, host, writes }
}

/**
 * Starts `ISLAND_DEF` and pumps until the island step is `running` — i.e. the
 * middleware has registered the handle and the pane could mount it, but the
 * mount has not settled yet (Decision 11's `running → waiting` seam).
 */
export async function startIslandRun(): Promise<IslandRun> {
  const { store, advance, host, writes } = islandStore()
  store.dispatch(
    startRun({
      impl: 'test',
      workflow: 'island',
      def: ISLAND_DEF,
      yaml: ISLAND_YAML,
      workflowName: 'Island',
      values: {},
    }),
  )

  await pumpUntil(advance, () => store.getState().run.state?.steps[ISLAND_KEY]?.status === 'running')

  return { store, advance, host, writes, runId: store.getState().run.state!.runId }
}

/** Call from `afterEach`: closes every store this module tracked (the runner singletons are global). */
export function resetIslandHarness(): void {
  for (const store of trackedStores) store.dispatch(runClosed())
  runnerControllers.abortAll()
  trackedStores.length = 0
}
