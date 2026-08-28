/**
 * `window.__workflow`, watched (07's page contract).
 *
 * Polling rather than an event: the global is a plain property the run page
 * rewrites on every render, and there is a commit between the kickoff page's
 * navigate and the run page's first publish where it is **absent** — so the
 * driver waits for `runId` to appear rather than reading the global the
 * instant the navigation lands.
 *
 * The refusal signal is the global's `status: 'invalid'`, never the
 * `kickoff-invalid` testid: only two of the six causes render that list, and
 * the four that do not (unlintable workflow, unreadable file, no such
 * workflow, discovery failure) are exactly the likeliest ways a CI run goes
 * wrong. Waiting on the testid would hang through all four.
 */
import { DriverError, EXIT } from './errors.js'
import type { PageLike } from './page.js'

export interface Snapshot {
  runId: string
  status: string
  currentSteps: string[]
  outputs: Record<string, unknown>
  steps: Record<string, string>
  errors?: Record<string, string>
}

export interface Transition {
  at: number
  /** A step key, or `run` for the run's own status. */
  key: string
  status: string
}

export interface WatchOptions {
  timeoutMs: number
  pollMs?: number
  onTransition?: (transition: Transition) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** The statuses a run stops at. `invalid` is a *page* state and never appears here. */
export const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function formatTransition(t: Transition): string {
  return `${new Date(t.at).toISOString()}\t${t.key}\t${t.status}`
}

/** One read of the global. `undefined` when no run page is mounted. */
export async function readGlobal(page: PageLike): Promise<Snapshot | undefined> {
  const raw = await page.evaluate<unknown>(() => (window as { __workflow?: unknown }).__workflow)
  if (raw === null || typeof raw !== 'object') return undefined
  const g = raw as Record<string, unknown>
  return {
    runId: typeof g.runId === 'string' ? g.runId : '',
    status: typeof g.status === 'string' ? g.status : '',
    currentSteps: Array.isArray(g.currentSteps) ? (g.currentSteps as string[]) : [],
    outputs: (g.outputs ?? {}) as Record<string, unknown>,
    steps: (g.steps ?? {}) as Record<string, string>,
    ...(g.errors && typeof g.errors === 'object'
      ? { errors: g.errors as Record<string, string> }
      : {}),
  }
}

async function poll(
  page: PageLike,
  o: WatchOptions,
  what: string,
  done: (snapshot: Snapshot) => boolean,
  observe?: (snapshot: Snapshot, at: number) => void,
): Promise<Snapshot> {
  const pollMs = o.pollMs ?? 1000
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? realSleep
  const deadline = now() + o.timeoutMs

  for (;;) {
    const snapshot = await readGlobal(page)
    if (snapshot !== undefined) {
      observe?.(snapshot, now())
      if (done(snapshot)) return snapshot
    }
    if (now() >= deadline) {
      throw new DriverError(
        `timed out after ${o.timeoutMs} ms waiting for ${what}`,
        EXIT.TIMEOUT,
      )
    }
    await sleep(pollMs)
  }
}

/**
 * The start, settled: a `runId` on the board (the run page mounted) or the
 * kickoff page's `invalid`. Both are answers; only a page that publishes
 * neither is a timeout.
 */
export async function waitForStart(page: PageLike, o: WatchOptions): Promise<Snapshot> {
  return poll(
    page,
    o,
    'the run to start',
    (s) => s.runId !== '' || s.status === 'invalid',
  )
}

/**
 * The run, followed to `succeeded` / `failed` / `cancelled`, logging each
 * status change exactly once. Steps are emitted before the run's own status so
 * the run's terminal line is always the last one in `steps.log`.
 */
export async function waitForTerminal(page: PageLike, o: WatchOptions): Promise<Snapshot> {
  const seen = new Map<string, string>()

  return poll(
    page,
    o,
    'the run to reach a terminal status',
    (s) => TERMINAL.has(s.status),
    (s, at) => {
      if (!o.onTransition) return
      for (const key of Object.keys(s.steps).sort()) {
        const status = s.steps[key]!
        if (seen.get(key) !== status) {
          seen.set(key, status)
          o.onTransition({ at, key, status })
        }
      }
      if (seen.get('run') !== s.status) {
        seen.set('run', s.status)
        o.onTransition({ at, key: 'run', status: s.status })
      }
    },
  )
}
