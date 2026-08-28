/**
 * One unattended run, end to end.
 *
 * The order is forced by the page contract (07): uploads happen **before** the
 * page opens (a `file` input's value must already be a File ref), the start URL
 * carries the values, and from there everything is read off
 * `window.__workflow` — never scraped from the DOM.
 */
import { Buffer } from 'node:buffer'
import { pageApi, type ApiLike } from './api.js'
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
import { waitForStart, waitForTerminal, formatTransition, type Transition } from './observe.js'
import type { BrowserLike, PageLike } from './page.js'
import { nodeUploadDeps, uploadFileInputs, type UploadDeps } from './upload.js'

export interface RunOptions {
  harnessUrl: string
  impl: string
  workflow: string
  inputs: Record<string, unknown>
  out?: string
  timeoutMs: number
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
}

export interface RunReport {
  runId: string
  /** `succeeded` · `failed` · `cancelled` · `invalid` (the page refused the start). */
  status: string
  url: string
  outputs: Record<string, unknown>
  errors?: Record<string, string>
  artifacts: DownloadResult
}

/** The `inputs` query parameter: base64url of the values object (07). */
export function encodeInputs(values: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url')
}

export function startUrl(o: Pick<RunOptions, 'harnessUrl' | 'impl' | 'workflow' | 'mocks'>, encoded: string): string {
  const base = o.harnessUrl.replace(/\/+$/, '')
  return `${base}/${o.impl}/${o.workflow}/run?auto=1&inputs=${encoded}${o.mocks ? '&mocks=on' : ''}`
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
    if (o.mocks) {
      // `?mocks=on` is persisted to localStorage by the app, so this one visit
      // also arms the mock backend for the start URL below.
      await page.goto(`${base}/?mocks=on`, { waitUntil: 'networkidle' })
    } else {
      if (!o.credentials) {
        throw new DriverError('no credentials: set WORKFLOW_EMAIL / WORKFLOW_PASSWORD', EXIT.USAGE)
      }
      // A login failure is the driver's least-covered path and, until this,
      // its least diagnosable: it happens before any artifact exists, so a
      // failed CI run had nothing to look at. The evidence that identifies a
      // bot challenge, an expired password or a changed form — the page the
      // browser is actually sitting on — is captured here.
      try {
        await loginViaRelay(page, base, o.credentials)
      } catch (error) {
        await shot('failed')
        await writeLogs()
        // `evaluate` rather than a new seam method: the page's own title and
        // first line of text is what distinguishes a bot challenge ("Just a
        // moment…") from a refused credential or a changed form.
        const seen = await page
          .evaluate(() => `${document.title} | ${document.body?.innerText?.slice(0, 200) ?? ''}`)
          .catch(() => '')
        const where = ` (stuck at ${page.url()}${seen ? `, showing ${JSON.stringify(seen)}` : ''})`
        if (error instanceof DriverError) throw new DriverError(error.message + where, error.code)
        throw error
      }
    }

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

    let terminal
    try {
      terminal = await waitForTerminal(page, {
        timeoutMs: o.timeoutMs,
        pollMs: 1000,
        onTransition: (t) => {
          transitions.push(t)
          deps.log(formatTransition(t))
        },
      })
    } catch (error) {
      await shot('failed')
      await writeLogs()
      throw error
    }

    await shot(`02-${terminal.status}`)
    if (terminal.status !== 'succeeded') await shot('failed')

    let outputs = terminal.outputs
    if (o.out) {
      const record = await api.json(`/api/workflow/run?id=${encodeURIComponent(started.runId)}`)
      if (record.status === 200) {
        await writeRunRecord(o.out, record.body)
      } else {
        warn(`could not read /api/workflow/run?id=${started.runId}: ${record.status}`)
        await writeRunRecord(o.out, {
          run: { runId: started.runId, status: terminal.status, outputs: terminal.outputs },
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

    const artifacts = o.out
      ? await downloadOutputs(api, o.out, outputs)
      : { written: [], failed: [] }
    for (const failure of artifacts.failed) warn(`output not downloaded: ${failure}`)

    await writeLogs()
    return { runId: started.runId, status: terminal.status, url, outputs, artifacts }
  } finally {
    await page.close().catch(() => {})
  }
}
