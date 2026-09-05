/**
 * `resume` — pick up a run a person has since answered, and drive it home.
 *
 * The other half of `--wait park` (DR9). A parked run is an ordinary `running`
 * row with no lease on it: whoever answers the step it waits on leaves it
 * exactly where the driver left it, and somebody has to start the engine again.
 * That is this verb — the same follow as a fresh run, minus the kickoff.
 *
 * The run id is all it is given, so the record comes first: `impl` and
 * `workflow` off the row are what say *which* run page to open, and the row's
 * status is what says whether opening one is worth doing at all. A run that
 * has already ended is reported at its own status without a navigation —
 * adopting a finished run would take a lease on something with nothing left to
 * do, and would leave the person who finished it looking at a page that
 * suddenly says another tab is driving.
 */
import { pageApi } from './api.js'
import { writeConsoleLog, writeStepsLog } from './artifacts.js'
import { DriverError, EXIT } from './errors.js'
import type { Credentials } from './login.js'
import { formatTransition, TERMINAL, waitForStart, type Transition } from './observe.js'
import type { PageLike } from './page.js'
import { collect, followRun, openHarness, type RunDeps, type RunReport } from './run.js'

export interface ResumeOptions {
  harnessUrl: string
  runId: string
  out?: string
  timeoutMs: number
  /** How long to keep watching a run that parks again on this driver's watch. */
  graceMs: number
  mocks: boolean
  token?: string
  appToken?: string
  credentials?: Credentials
}

/** The record fields `resume` cannot proceed without. */
function routeOf(body: unknown): { impl: string; workflow: string; status: string; outputs: Record<string, unknown> } {
  const run = (((body ?? {}) as { run?: unknown }).run ?? {}) as Record<string, unknown>
  return {
    impl: typeof run.impl === 'string' ? run.impl : '',
    workflow: typeof run.workflow === 'string' ? run.workflow : '',
    status: typeof run.status === 'string' ? run.status : '',
    outputs: (run.outputs ?? {}) as Record<string, unknown>,
  }
}

export async function resumeRun(o: ResumeOptions, deps: RunDeps): Promise<RunReport> {
  const warn = deps.warn ?? deps.log
  const base = o.harnessUrl.replace(/\/+$/, '')
  const page: PageLike = await deps.browser.newPage({ viewport: { width: 1280, height: 900 } })

  const consoleLines: string[] = []
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', (error: Error) => consoleLines.push(`pageerror: ${error.message}`))

  const transitions: Transition[] = []
  const api = pageApi(page, {
    base,
    ...(o.token ? { token: o.token } : {}),
    ...(o.appToken ? { appToken: o.appToken } : {}),
  })

  const shot = async (name: string) => {
    if (!o.out) return
    await page.screenshot({ path: `${o.out}/${name}.png`, fullPage: true }).catch(() => {})
  }
  const writeLogs = async () => {
    if (!o.out) return
    await writeStepsLog(o.out, transitions)
    await writeConsoleLog(o.out, consoleLines)
  }

  try {
    await openHarness({
      page,
      base,
      mocks: o.mocks,
      ...(o.credentials ? { credentials: o.credentials } : {}),
      shot,
      writeLogs,
    })

    const record = await api.json(`/api/workflow/run?id=${encodeURIComponent(o.runId)}`)
    if (record.status !== 200) {
      // Deliberately not `FAILED`: a record the driver could not read says
      // nothing about how the run went (errors.ts).
      throw new DriverError(
        `could not read the run record for ${o.runId}: ${record.status}`,
        EXIT.USAGE,
      )
    }
    const { impl, workflow, status, outputs: recorded } = routeOf(record.body)
    if (impl === '' || workflow === '') {
      throw new DriverError(
        `run ${o.runId} does not say which workflow it belongs to — no impl/workflow on the record`,
        EXIT.USAGE,
      )
    }
    const runUrl = `${base}/${impl}/${workflow}/runs/${o.runId}`

    if (TERMINAL.has(status)) {
      deps.log(`${o.runId} is already ${status}`)
      const done = await collect({
        api,
        runId: o.runId,
        ...(o.out === undefined ? {} : { out: o.out }),
        status,
        outputs: recorded,
        warn,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      })
      await writeLogs()
      return { runId: o.runId, status, url: runUrl, outputs: done.outputs, artifacts: done.artifacts }
    }

    // `resume=1` is what makes the page adopt the lease without a person
    // clicking Resume; `wait=park` keeps this driver's promise for the rest of
    // the run — a second interactive step parks again rather than failing.
    const url = `${runUrl}?resume=1&wait=park`
    deps.log(`opening ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    try {
      await waitForStart(page, { timeoutMs: Math.min(o.timeoutMs, 120_000), pollMs: 250 })
    } catch (error) {
      await shot('failed')
      await writeLogs()
      throw error
    }
    await shot('01-resume')

    let followed
    try {
      followed = await followRun({
        page,
        api,
        runId: o.runId,
        runUrl,
        timeoutMs: o.timeoutMs,
        graceMs: o.graceMs,
        park: true,
        log: deps.log,
        sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        now: Date.now,
        onTransition: (t) => {
          transitions.push(t)
          deps.log(formatTransition(t))
        },
        shot,
      })
    } catch (error) {
      await shot('failed')
      await writeLogs()
      throw error
    }

    if (TERMINAL.has(followed.status)) {
      await shot(`02-${followed.status}`)
      if (followed.status !== 'succeeded') await shot('failed')
    }

    const done = await collect({
      api,
      runId: o.runId,
      ...(o.out === undefined ? {} : { out: o.out }),
      status: followed.status,
      outputs: followed.outputs,
      warn,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    })

    await writeLogs()
    return {
      runId: o.runId,
      status: followed.status,
      url,
      outputs: done.outputs,
      ...(followed.parkedOn.length > 0 ? { parkedOn: followed.parkedOn } : {}),
      artifacts: done.artifacts,
    }
  } finally {
    await page.close().catch(() => {})
  }
}
