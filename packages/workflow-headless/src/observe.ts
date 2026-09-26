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
  /**
   * A second, slower question asked while the poll waits: has the page this
   * driver is watching stopped driving? `followRun` answers it off the run
   * record's lease (apps#716). `true` ends the wait with `status: 'stalled'`.
   * Unset asks nothing — `waitForStart` never sets it, so a slow-to-mount run
   * page is only ever a timeout.
   */
  stalled?: () => Promise<boolean>
  /** How often `stalled` is asked; the first ask is one interval in. Default `GRACE_POLL_MS`. */
  stallPollMs?: number
}

/**
 * How often the *record* is re-read while a leg waits on the page — the grace
 * window after a park, and the stall check during a follow. Slower than the
 * page poll because it is an API round trip, not a property read.
 */
export const GRACE_POLL_MS = 10_000

/** The statuses a run stops at. `invalid` is a *page* state and never appears here. */
export const TERMINAL: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * The statuses a *driver* stops following at: the run's own terminal three plus
 * the three page states at which the page has stopped driving — `parked` and
 * `busy` from a driven run (07 `wait=park`, `resume=1`), and `paused`, the
 * page's own word for a heartbeat it has given up (apps#715).
 *
 * None of the three is a run status — the row behind each still says
 * `running` — but they are all facts about the page this driver is looking at,
 * and in every case the page has stopped driving. Following past them is a
 * guaranteed timeout: nothing on that page will ever move again.
 */
export const SETTLED: ReadonlySet<string> = new Set([...TERMINAL, 'parked', 'busy', 'paused'])

/** What `poll` hands back when the record says the page stalled before the page ever published. */
const NO_SNAPSHOT: Snapshot = { runId: '', status: '', currentSteps: [], outputs: {}, steps: {} }

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
  const start = now()
  const deadline = start + o.timeoutMs
  const stallPollMs = o.stallPollMs ?? GRACE_POLL_MS
  let nextStall = start + stallPollMs
  let last: Snapshot | undefined

  for (;;) {
    const snapshot = await readGlobal(page)
    if (snapshot !== undefined) {
      last = snapshot
      observe?.(snapshot, now())
      if (done(snapshot)) return snapshot
    }
    // The page's own answer wins when it has one; the record is asked only on
    // its own cadence, and only when the caller gave us something to ask.
    if (o.stalled && now() >= nextStall) {
      nextStall += stallPollMs
      if (await o.stalled()) return { ...(last ?? NO_SNAPSHOT), status: 'stalled' }
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
 * The run, followed until `done`, logging each status change exactly once.
 * Steps are emitted before the run's own status so the run's last line is
 * always the run's own in `steps.log`.
 *
 * `seen` is per call, which matters to `followRun`: a driver that parks and
 * later resumes calls this again on a freshly loaded page, and the second call
 * re-states the board it finds. That is the intent — the log then shows what
 * was true when the run was picked back up, rather than silently skipping
 * every step that had already moved before the resume.
 */
function waitUntil(
  page: PageLike,
  o: WatchOptions,
  what: string,
  done: (snapshot: Snapshot) => boolean,
): Promise<Snapshot> {
  const seen = new Map<string, string>()

  return poll(
    page,
    o,
    what,
    done,
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

/**
 * The run, followed to `succeeded` / `failed` / `cancelled` — or to a page
 * that says `paused`, which no `--wait` mode can follow past: the page has
 * stopped driving, and `TERMINAL` itself is unchanged because `paused` is not
 * where the *run* stops.
 */
export async function waitForTerminal(page: PageLike, o: WatchOptions): Promise<Snapshot> {
  return waitUntil(
    page,
    o,
    'the run to reach a terminal status',
    (s) => TERMINAL.has(s.status) || s.status === 'paused',
  )
}

/**
 * The run, followed until the *driver* is done with it: terminal, or a page
 * that has stopped driving (`parked`, `busy`, `paused`). What `--wait park` and
 * `resume` wait on; `--wait fail` still waits for the run's own end.
 */
export async function waitForSettled(page: PageLike, o: WatchOptions): Promise<Snapshot> {
  return waitUntil(page, o, 'the run to settle', (s) => SETTLED.has(s.status))
}
