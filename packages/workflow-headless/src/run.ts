/**
 * One unattended run, end to end.
 *
 * The order is forced by the page contract (07): uploads happen **before** the
 * page opens (a `file` input's value must already be a File ref), the start URL
 * carries the values, and from there everything is read off
 * `window.__workflow` — never scraped from the DOM.
 */
import { Buffer } from 'node:buffer'
import { pageApi, type ApiLike, type JsonResponse } from './api.js'
import {
  downloadOutputs,
  writeConsoleLog,
  writeRunRecord,
  writeStepsLog,
  type DownloadResult,
} from './artifacts.js'
import { fetchDefinition } from './discover.js'
import { DriverError, EXIT } from './errors.js'
import { loginViaRelay, type Credentials } from './login.js'
import {
  TERMINAL,
  waitForSettled,
  waitForStart,
  waitForTerminal,
  formatTransition,
  type Transition,
} from './observe.js'
import type { BrowserLike, PageLike } from './page.js'
import { nodeUploadDeps, uploadFileInputs, type UploadDeps } from './upload.js'

export interface RunOptions {
  harnessUrl: string
  impl: string
  workflow: string
  inputs: Record<string, unknown>
  out?: string
  timeoutMs: number
  /**
   * What to do at a step that needs a person: `fail` (the default) follows the
   * run to its own end, which for an undeclared interactive step means the
   * failure the harness produces; `park` asks the page to hand the run back
   * instead (07 `wait=park`).
   */
  wait?: 'fail' | 'park'
  /** The run's pre-minted id, so a `--wait park` run and its `resume` share one. */
  runId?: string
  /** `wait: 'park'` only: how long to keep watching a parked run for an answer. */
  graceMs?: number
  mocks: boolean
  token?: string
  credentials?: Credentials
}

export interface RunDeps {
  browser: BrowserLike
  log: (line: string) => void
  warn?: (line: string) => void
  /** Handed a way to click Cancel, once there is a run page to click it on. */
  onReady?: (control: { cancel: () => Promise<void> }) => void
  uploadDeps?: UploadDeps
  /** Test seam for the driver's own waits; real time by default. */
  sleep?: (ms: number) => Promise<void>
}

export interface RunReport {
  runId: string
  /**
   * `succeeded` · `failed` · `cancelled` · `invalid` (the page refused the
   * start) · `parked` (the run waits on a person; the row is still `running`)
   * · `busy` (another tab or job holds the lease — reachable from `resume`,
   * or from `run --wait park` after a grace resume races another lease-taker).
   */
  status: string
  url: string
  outputs: Record<string, unknown>
  errors?: Record<string, string>
  /** Only on `parked`: the step keys the run is waiting on a person for. */
  parkedOn?: string[]
  artifacts: DownloadResult
}

/** The `inputs` query parameter: base64url of the values object (07). */
export function encodeInputs(values: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url')
}

export function startUrl(
  o: Pick<RunOptions, 'harnessUrl' | 'impl' | 'workflow' | 'mocks' | 'wait' | 'runId'>,
  encoded: string,
): string {
  const base = o.harnessUrl.replace(/\/+$/, '')
  // `wait=park` and `runId=` are both instructions to the *kickoff* page (07):
  // park at a step that needs a person rather than failing, and insert the row
  // under an id the driver already knows — so a `--wait park` run and the
  // `resume` that finishes it are the same run without a lookup in between.
  const park = o.wait === 'park' ? '&wait=park' : ''
  const runId = o.runId ? `&runId=${encodeURIComponent(o.runId)}` : ''
  return `${base}/${o.impl}/${o.workflow}/run?auto=1&inputs=${encoded}${o.mocks ? '&mocks=on' : ''}${park}${runId}`
}

/**
 * The index is read through the page, and in `--mocks` mode the page's backend
 * is a service worker that has only just been claimed — a couple of retries
 * costs nothing and turns a startup race into a non-event.
 */
async function definitionWithRetry(
  api: ApiLike,
  impl: string,
  workflow: string,
  warn: (line: string) => void,
  sleep: (ms: number) => Promise<void>,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = await fetchDefinition(api, impl, workflow, attempt === 2 ? warn : () => {})
    if (found) return found
    if (attempt < 2) await sleep(500)
  }
  return undefined
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The record's own status, read off a `/api/workflow/run?id=` body. */
function recordStatus(body: unknown): string {
  const run = ((body ?? {}) as { run?: { status?: unknown } }).run
  return typeof run?.status === 'string' ? run.status : ''
}

/**
 * The page's terminal pill and the run record are written by two different
 * actors, and the record's is the one a closed browser kills: the SPA seals
 * the run with a `keepalive` `POST /api/workflow/run/update` (apps#539), a
 * promise that survives a tab close but **not** `browser.close()` of the
 * whole headless process. The live `headless` walk of 2026-08-30 hit exactly
 * that window — the driver saw "Succeeded", exited 0, and left
 * `run_01M1BREJZK5V77ZRPXKTG7ZG7C` reporting `running` forever.
 *
 * So after the page shows terminal, the browser is held open until the
 * *record* agrees, bounded: the freshest read is returned either way, and a
 * bound that expires is a warning, never a new exit code — the page's own
 * terminal status stays the run's verdict.
 */
export async function waitForSealedRecord(
  api: ApiLike,
  runId: string,
  warn: (line: string) => void,
  o: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<JsonResponse> {
  const timeoutMs = o.timeoutMs ?? 15_000
  const pollMs = o.pollMs ?? 500
  const wait = o.sleep ?? sleep
  const url = `/api/workflow/run?id=${encodeURIComponent(runId)}`
  // Attempt-counted rather than clock-checked so an instant test `sleep`
  // still terminates: the bound is the number of polls the timeout buys.
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs))

  let freshest: JsonResponse = { status: 0, body: null }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    freshest = await api.json(url)
    if (freshest.status === 200 && TERMINAL.has(recordStatus(freshest.body))) return freshest
    if (attempt < attempts - 1) await wait(pollMs)
  }
  const seen = freshest.status === 200 ? `still reports ${recordStatus(freshest.body) || 'no status'}` : `read ${freshest.status}`
  warn(`run record ${runId} ${seen} after ${timeoutMs} ms — the sealing update may not have landed`)
  return freshest
}

/**
 * Get the browser into a state where the harness's API answers: either the
 * mock backend, or a real member session through the admin relay. Both verbs
 * start here, and `resume` needs it *before* it knows which page to open —
 * the record it reads to find that out is behind the same gate.
 *
 * A login failure is the driver's least-covered path and, until this, its
 * least diagnosable: it happens before any artifact exists, so a failed CI run
 * had nothing to look at. The evidence that identifies a bot challenge, an
 * expired password or a changed form — the page the browser is actually
 * sitting on — is captured here.
 */
export async function openHarness(o: {
  page: PageLike
  base: string
  mocks: boolean
  credentials?: Credentials
  shot: (name: string) => Promise<void>
  writeLogs: () => Promise<void>
}): Promise<void> {
  if (o.mocks) {
    // `?mocks=on` is persisted to localStorage by the app, so this one visit
    // also arms the mock backend for every url opened after it.
    await o.page.goto(`${o.base}/?mocks=on`, { waitUntil: 'networkidle' })
    return
  }
  if (!o.credentials) {
    throw new DriverError('no credentials: set WORKFLOW_EMAIL / WORKFLOW_PASSWORD', EXIT.USAGE)
  }
  try {
    await loginViaRelay(o.page, o.base, o.credentials)
  } catch (error) {
    await o.shot('failed')
    await o.writeLogs()
    // `evaluate` rather than a new seam method: the page's own title and
    // first line of text is what distinguishes a bot challenge ("Just a
    // moment…") from a refused credential or a changed form.
    const seen = await o.page
      .evaluate(() => `${document.title} | ${document.body?.innerText?.slice(0, 200) ?? ''}`)
      .catch(() => '')
    const where = ` (stuck at ${o.page.url()}${seen ? `, showing ${JSON.stringify(seen)}` : ''})`
    if (error instanceof DriverError) throw new DriverError(error.message + where, error.code)
    throw error
  }
}

/**
 * A step row, whether the record hands it back bare or wrapped. The query
 * endpoint answers with `{ fields }` envelopes and the run endpoint with plain
 * objects, and which one a caller gets is not worth a branch at every read.
 */
function fieldsOf(row: unknown): Record<string, unknown> {
  const record = (row ?? {}) as Record<string, unknown>
  return record.fields && typeof record.fields === 'object'
    ? (record.fields as Record<string, unknown>)
    : record
}

/** A parked step has its answer once its row has stopped waiting — however it stopped. */
const ANSWERED: ReadonlySet<string> = new Set(['succeeded', 'failed', 'skipped', 'cancelled'])

/**
 * What the record says a parked driver should do. Pure, and exported, because
 * it is the whole decision the grace window turns on and it deserves to be
 * readable on its own:
 *
 *  - the run ended under us (a person cancelled it, or drove it home in their
 *    own tab) → its status, and the follow is over;
 *  - somebody holds a live lease → `held`: a person's tab (DR4) or a second
 *    job is driving it now, and two drivers on one run is precisely what the
 *    lease exists to prevent;
 *  - every parked step answered → `answered`, the cue to resume;
 *  - anything else → `wait`.
 *
 * Note the order: a terminal run is terminal whoever holds the lease, and a
 * live lease outranks the answers — the person who answered may well be the
 * one now driving.
 */
export function graceVerdict(
  body: unknown,
  parkedOn: string[],
  now: number,
): 'wait' | 'held' | 'answered' | 'succeeded' | 'failed' | 'cancelled' {
  const record = (body ?? {}) as { run?: unknown; steps?: unknown }
  const run = (record.run ?? {}) as Record<string, unknown>

  const status = typeof run.status === 'string' ? run.status : ''
  if (TERMINAL.has(status)) return status as 'succeeded' | 'failed' | 'cancelled'

  const leaseOwner = typeof run.leaseOwner === 'string' ? run.leaseOwner : ''
  const leaseUntil = typeof run.leaseUntil === 'number' ? run.leaseUntil : 0
  if (leaseOwner !== '' && leaseUntil > now) return 'held'

  const rows = (Array.isArray(record.steps) ? record.steps : []).map(fieldsOf)
  for (const key of parkedOn) {
    const row = rows.find((r) => r.key === key)
    if (!ANSWERED.has(typeof row?.status === 'string' ? row.status : '')) return 'wait'
  }
  return 'answered'
}

export interface FollowContext {
  page: PageLike
  api: ApiLike
  runId: string
  /** The run page's own url, without a query — `${base}/${impl}/${workflow}/runs/${runId}`. */
  runUrl: string
  timeoutMs: number
  graceMs: number
  /** Whether the page was asked to park; `false` follows the run to its own end. */
  park: boolean
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  onTransition: (transition: Transition) => void
  shot: (name: string) => Promise<void>
}

/** How often the record is re-read while the grace window is open. */
const GRACE_POLL_MS = 10_000

/**
 * Follow a run this driver is on the page of, through as many parks as the
 * grace window allows (DR9).
 *
 * A park releases the lease, so the run is genuinely handed back: while the
 * window is open the *record* is what the driver watches — the page it is
 * holding has stopped moving by definition. If every parked step has been
 * answered and nobody took the lease, the page is re-opened with `resume=1`
 * (07) and followed again in this same job, which is what makes "someone
 * approves it two minutes later" one CI job rather than two.
 *
 * A live lease means a person's tab (DR4) or another job has it — leave it to
 * them and report the park.
 */
export async function followRun(
  ctx: FollowContext,
): Promise<{ status: string; outputs: Record<string, unknown>; parkedOn: string[] }> {
  // `timeoutMs` is per leg, not per job: a resumed run has just been answered
  // by a person, and holding it to what was left of the first leg's budget
  // would time out a run that is moving. The loop is still bounded — every
  // turn either ends the job or consumes an interactive step's answer.
  for (;;) {
    const wait = ctx.park ? waitForSettled : waitForTerminal
    const settled = await wait(ctx.page, {
      timeoutMs: ctx.timeoutMs,
      pollMs: 1000,
      onTransition: ctx.onTransition,
    })
    if (settled.status !== 'parked') {
      return { status: settled.status, outputs: settled.outputs, parkedOn: [] }
    }

    const parkedOn = settled.currentSteps
    ctx.log(`parked on ${parkedOn.join(', ')}`)
    await ctx.shot('03-parked')

    const deadline = ctx.now() + ctx.graceMs
    for (;;) {
      // Checked before the sleep, so `--grace 0` is honestly zero: the driver
      // reports the park without holding a browser open for a poll nobody
      // asked for.
      if (ctx.now() >= deadline) return { status: 'parked', outputs: {}, parkedOn }
      await ctx.sleep(Math.min(GRACE_POLL_MS, Math.max(0, deadline - ctx.now())))

      const record = await ctx.api.json(`/api/workflow/run?id=${encodeURIComponent(ctx.runId)}`)
      const verdict = graceVerdict(record.body, parkedOn, ctx.now())
      if (verdict === 'wait') continue
      if (verdict === 'held') {
        ctx.log('a page or another driver took the run')
        return { status: 'parked', outputs: {}, parkedOn }
      }
      if (verdict === 'answered') {
        ctx.log('answered — resuming')
        await ctx.page.goto(`${ctx.runUrl}?resume=1&wait=park`, { waitUntil: 'domcontentloaded' })
        // Capped at two minutes however long `--timeout` is, for the same
        // reason the first start is: a run page that has not published its
        // `runId` by then is not slow, it is wrong.
        await waitForStart(ctx.page, { timeoutMs: Math.min(ctx.timeoutMs, 120_000), pollMs: 250 })
        break
      }
      // The record went terminal under us — a person finished it elsewhere.
      return { status: verdict, outputs: {}, parkedOn: [] }
    }
  }
}

/**
 * The tail both verbs share: the record, `run.json`, and the file outputs.
 *
 * The seal wait is only for a run that actually ended (see
 * `waitForSealedRecord`) — a `parked` or `busy` record is *supposed* to say
 * `running`, and waiting for it to say otherwise would be waiting for the
 * person. It still gets a `run.json`, because the freshest record is exactly
 * what tells a human (or the next `resume`) where the run stopped. Outputs are
 * a terminal run's only: a parked run has none yet.
 */
export async function collect(o: {
  api: ApiLike
  runId: string
  out?: string
  status: string
  outputs: Record<string, unknown>
  warn: (line: string) => void
  sleep?: (ms: number) => Promise<void>
}): Promise<{ outputs: Record<string, unknown>; artifacts: DownloadResult }> {
  const terminal = TERMINAL.has(o.status)
  const record = terminal
    ? await waitForSealedRecord(o.api, o.runId, o.warn, { ...(o.sleep ? { sleep: o.sleep } : {}) })
    : await o.api.json(`/api/workflow/run?id=${encodeURIComponent(o.runId)}`)

  let outputs = o.outputs
  if (o.out) {
    if (record.status === 200) {
      await writeRunRecord(o.out, record.body)
    } else {
      o.warn(`could not read /api/workflow/run?id=${o.runId}: ${record.status}`)
      await writeRunRecord(o.out, {
        run: { runId: o.runId, status: o.status, outputs: o.outputs },
        steps: [],
        _driverNote: `the record could not be read (${record.status}); this is the page's own snapshot`,
      })
    }
    if (Object.keys(outputs).length === 0) {
      const run = ((record.body ?? {}) as { run?: { outputs?: unknown } }).run
      if (run?.outputs && typeof run.outputs === 'object') {
        outputs = run.outputs as Record<string, unknown>
      }
    }
  }

  const artifacts =
    o.out && terminal ? await downloadOutputs(o.api, o.out, outputs) : { written: [], failed: [] }
  for (const failure of artifacts.failed) o.warn(`output not downloaded: ${failure}`)
  return { outputs, artifacts }
}

export async function runWorkflow(o: RunOptions, deps: RunDeps): Promise<RunReport> {
  const warn = deps.warn ?? deps.log
  const base = o.harnessUrl.replace(/\/+$/, '')
  const page: PageLike = await deps.browser.newPage({ viewport: { width: 1280, height: 900 } })

  const consoleLines: string[] = []
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', (error: Error) => consoleLines.push(`pageerror: ${error.message}`))

  const transitions: Transition[] = []
  const api = pageApi(page, { base, ...(o.token ? { token: o.token } : {}) })

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

    const definition = await definitionWithRetry(api, o.impl, o.workflow, warn, sleep)
    if (definition?.listing.headlessSafe === false) {
      warn(`warning: ${o.impl}/${o.workflow} is not marked headlessSafe — an interactive step may fail fast`)
    }

    const values = await uploadFileInputs(
      api,
      { impl: o.impl, workflow: o.workflow },
      definition?.inputs ?? {},
      o.inputs,
      deps.uploadDeps ?? nodeUploadDeps,
    )

    const url = startUrl(o, encodeInputs(values))
    deps.log(`opening ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    let started
    try {
      // The start is capped at two minutes however long `--timeout` is: a
      // harness that has not published a `runId` by then is not slow, it is
      // wrong.
      started = await waitForStart(page, {
        timeoutMs: Math.min(o.timeoutMs, 120_000),
        pollMs: 250,
      })
    } catch (error) {
      // Wrapped for the same reason `waitForTerminal` is, and with more at
      // stake: a timeout here is the one *un-diagnosable* refusal. Every
      // diagnosable one comes back as `invalid` (exit 3) and writes its own
      // artifacts, so an auth bounce loop, a JS error on the run page or a
      // harness that renders but never publishes would otherwise leave an
      // empty `--out` and nothing to look at.
      await shot('failed')
      await writeLogs()
      throw error
    }
    await shot('01-start')

    if (started.status === 'invalid') {
      await shot('failed')
      await writeLogs()
      const errors = started.errors ?? {}
      for (const [key, message] of Object.entries(errors)) warn(`invalid: ${key}: ${message}`)
      return {
        runId: '',
        status: 'invalid',
        url,
        outputs: {},
        errors,
        artifacts: { written: [], failed: [] },
      }
    }

    deps.log(`run ${started.runId}`)
    deps.onReady?.({
      cancel: async () => {
        await page.click('[data-testid="run-cancel"]', { timeout: 10_000 }).catch(() => {})
      },
    })

    let followed
    try {
      followed = await followRun({
        page,
        api,
        runId: started.runId,
        runUrl: `${base}/${o.impl}/${o.workflow}/runs/${started.runId}`,
        timeoutMs: o.timeoutMs,
        graceMs: o.graceMs ?? 0,
        park: o.wait === 'park',
        log: deps.log,
        sleep: deps.sleep ?? sleep,
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

    // Nothing may close the browser before this: a terminal page's in-flight
    // sealing update still has to land (see `waitForSealedRecord`).
    const { outputs, artifacts } = await collect({
      api,
      runId: started.runId,
      ...(o.out === undefined ? {} : { out: o.out }),
      status: followed.status,
      outputs: followed.outputs,
      warn,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    })

    await writeLogs()
    return {
      runId: started.runId,
      status: followed.status,
      url,
      outputs,
      ...(followed.parkedOn.length > 0 ? { parkedOn: followed.parkedOn } : {}),
      artifacts,
    }
  } finally {
    await page.close().catch(() => {})
  }
}
