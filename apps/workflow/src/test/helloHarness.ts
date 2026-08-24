/**
 * Task 18's shared support for driving the `hello` implementation (docs/spec/
 * examples/hello.workflow.yaml) to `confirm/0/review` waiting against the
 * real runner middleware + the MSW mock backend — Task 17's own scenario-2
 * harness (`runnerMiddleware.test.ts`), lifted out so the form-pane and
 * live-run-page tests don't each reinvent the virtual clock and pump loop.
 *
 * Not a `*.test.ts` file itself (vitest's `include` only matches `.test`/
 * `.spec`), so this never runs as its own suite.
 */
import { httpJson } from '../lib/http'
import { loadWorkflow } from '../lib/runner/definition'
import type { Clock } from '../lib/runner/adapters/pipeline'
import type { Definition } from '../lib/runner/types'
import { createRunStore } from '../lib/runStore'
import type { AppStore } from '../store'
import { makeStore } from '../store'
import { createRegisterFile, runnerControllers } from '../store/runnerMiddleware'
import type { RunnerDeps } from '../store/runnerMiddleware'
import { startRun } from '../store/runnerActions'
import { runClosed } from '../store/runSlice'
import helloYaml from '../../docs/spec/examples/hello.workflow.yaml?raw'

export const HELLO_YAML = helloYaml
export const hello = loadWorkflow(helloYaml, 'hello.workflow.yaml').def as Definition
export const REVIEW_KEY = 'confirm/0/review'

/** A manually-driven virtual clock: `sleep` only resolves once `advance` has moved `now` past its deadline. */
export function virtualClock(start = 1_000) {
  let now = start
  interface Waiter { due: number; resolve: () => void; unlisten: () => void }
  const waiters: Waiter[] = []

  const clock: Clock = {
    now: () => now,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        const onAbort = () => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
          reject(new DOMException('aborted', 'AbortError'))
        }
        const waiter: Waiter = {
          due: now + ms,
          resolve: () => {
            waiter.unlisten()
            resolve()
          },
          unlisten: () => signal?.removeEventListener('abort', onAbort),
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
      }),
  }

  /** Move `now` forward and resolve every due `sleep`, flushing real microtasks/macrotasks between rounds so resumed code can register its next wait. */
  async function advance(ms: number): Promise<void> {
    now += ms
    for (let round = 0; round < 50; round++) {
      const due = waiters.filter((w) => w.due <= now)
      if (due.length === 0) return
      for (const w of [...due]) {
        const i = waiters.indexOf(w)
        if (i >= 0) waiters.splice(i, 1)
        w.resolve()
      }
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  return { clock, advance }
}

/** Flush pending microtasks/macrotasks without moving the virtual clock. */
export async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Advance the virtual clock in small steps, flushing real ticks, until `predicate` holds. */
export async function pumpUntil(
  advance: (ms: number) => Promise<void>,
  predicate: () => boolean,
  opts: { stepMs?: number; maxSteps?: number } = {},
): Promise<void> {
  const stepMs = opts.stepMs ?? 250
  for (let i = 0; i < (opts.maxSteps ?? 200); i++) {
    if (predicate()) return
    await advance(stepMs)
    await new Promise((r) => setTimeout(r, 0))
  }
  if (!predicate()) throw new Error('pumpUntil: condition never became true')
}

const trackedStores: AppStore[] = []

/** A fresh store wired against the real MSW backend and a fresh virtual clock. */
export function trackedHelloStore(): { store: AppStore; advance: (ms: number) => Promise<void> } {
  const { clock, advance } = virtualClock()
  const deps: RunnerDeps = {
    http: httpJson,
    clock,
    runStore: createRunStore(httpJson),
    registerFile: createRegisterFile(httpJson),
  }
  const store = makeStore(deps)
  trackedStores.push(store)
  return { store, advance }
}

/**
 * Starts `hello` and pumps the virtual clock until `confirm/0/review` is
 * `waiting` — `slow`'s retried poll and `flaky`'s failure have already
 * settled by the time this resolves, same as `runnerMiddleware.test.ts`'s
 * own scenario 2.
 */
export async function startHelloAtConfirmWaiting(
  values: Record<string, unknown> = { greeting: 'Hello', names: ['world', 'studio'], photo: null, shout: false },
): Promise<{ store: AppStore; advance: (ms: number) => Promise<void>; runId: string }> {
  const { store, advance } = trackedHelloStore()
  store.dispatch(
    startRun({
      impl: 'hello',
      workflow: 'hello',
      def: hello,
      yaml: helloYaml,
      workflowName: 'Hello workflow',
      values,
    }),
  )

  await pumpUntil(advance, () => store.getState().run.state?.steps[REVIEW_KEY]?.status === 'waiting', {
    maxSteps: 400,
  })

  const runId = store.getState().run.state!.runId
  return { store, advance, runId }
}

/** Call from `afterEach`: closes every store this module tracked and clears the module-level runner singletons (Task 17: controllers/heartbeats/write-queues are global, not per-store). */
export function resetHelloHarness(): void {
  for (const store of trackedStores) store.dispatch(runClosed())
  runnerControllers.abortAll()
  trackedStores.length = 0
}
