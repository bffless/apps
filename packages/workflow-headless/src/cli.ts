#!/usr/bin/env node
/**
 * `workflow-headless` — argv in, one of Decision 13's exit codes out.
 *
 * The exit code is the whole point of the CLI: everything above it returns a
 * `RunReport` and this maps it. SIGINT is the odd one — it clicks the page's
 * Cancel and then waits for the run to actually reach `cancelled`, so CI's
 * record says the run was cancelled rather than that the driver vanished.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pageApi } from './api.js'
import {
  credentialsFromEnv,
  loadInputs,
  parseArgs,
  UsageError,
  USAGE,
  type ResumeCommand,
  type RunCommand,
  type RunsCommand,
} from './args.js'
import { launchBrowser } from './browser.js'
import { DriverError, EXIT, type ExitCode } from './errors.js'
import { loginViaRelay } from './login.js'
import type { BrowserLike } from './page.js'
import { resumeRun } from './resume.js'
import { formatRunsTable, listRuns } from './runs.js'
import { runWorkflow, type RunReport } from './run.js'

/** Shared with the catch-all so a Ctrl-C's own fallout is not reported as a fault. */
interface Interrupt {
  leaving: boolean
}

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
  env: NodeJS.ProcessEnv
  launch?: (options: { headed?: boolean }) => Promise<BrowserLike>
  /** Registers the SIGINT handler; overridable so tests never touch `process`. */
  onSigint?: (handler: () => void) => void
  /** Leaves now with this code — the second-Ctrl-C escape hatch. */
  forceExit?: (code: number) => void
}

/**
 * The SIGINT of last resort: close the browser, then leave with 130.
 *
 * Something has to do this from the moment the browser exists. Playwright's
 * own SIGINT handler is off (see `browser.ts`), and the cleanup it would
 * otherwise fall back on runs on `process.on('exit')`, which an unhandled
 * signal never reaches — so a Ctrl-C during the login, the uploads, the start
 * wait, or anywhere in `runs` would leave a headless Chromium behind.
 */
function closeAndExit(browser: BrowserLike, io: CliIo, why: string, state: Interrupt): void {
  // Closing the browser aborts whatever navigation or evaluate was in flight,
  // which surfaces a moment later as an exception. It is not news — we are
  // already leaving — so the catch-all is told to stay quiet.
  state.leaving = true
  io.err(why)
  void browser
    .close()
    .catch(() => {})
    .then(() => io.forceExit?.(EXIT.SIGINT))
}

function exitFor(report: RunReport, sigint: boolean): ExitCode {
  if (report.status === 'invalid') return EXIT.INVALID
  // A parked run is a clean end, not a failure: the work got as far as it can
  // without a person, and `run.json` says where it stopped. CI branches on
  // this, so it must not look like the run failed.
  if (report.status === 'succeeded' || report.status === 'parked') return EXIT.OK
  // `busy` did no work at all — its own code, so a retry can tell it apart
  // from a run that ran and failed.
  if (report.status === 'busy') return EXIT.BUSY
  if (report.status === 'cancelled' && sigint) return EXIT.SIGINT
  return EXIT.FAILED
}

/** The one line a person reads off the end of a job. */
function announce(report: RunReport, io: CliIo): void {
  if (report.status === 'succeeded') io.out(`succeeded: ${report.runId}`)
  else if (report.status === 'parked') {
    io.out(`parked: ${report.runId} (${(report.parkedOn ?? []).join(', ')})`)
  } else if (report.status !== 'invalid') io.err(`${report.status}: ${report.runId}`)
  for (const path of report.artifacts.written) io.out(`wrote ${path}`)
}

async function doRun(command: RunCommand, io: CliIo, state: Interrupt): Promise<ExitCode> {
  const inputs = loadInputs(command.inputsFile)
  const credentials = command.mocks ? undefined : credentialsFromEnv(io.env)
  const browser = await (io.launch ?? launchBrowser)({ headed: command.headed })

  let sigint = false
  // Registered once, immediately: everything before the run page exists (the
  // relay login, discovery, the uploads, the start wait) has nothing to Cancel
  // but does have a browser to close. `onReady` upgrades it in place rather
  // than adding a second listener.
  let onInterrupt = () => closeAndExit(browser, io, 'SIGINT — closing the browser', state)
  io.onSigint?.(() => onInterrupt())

  try {
    const report = await runWorkflow(
      {
        harnessUrl: command.harnessUrl,
        impl: command.impl,
        workflow: command.workflow,
        inputs,
        ...(command.out === undefined ? {} : { out: command.out }),
        timeoutMs: command.timeoutMs,
        wait: command.wait,
        ...(command.runId === undefined ? {} : { runId: command.runId }),
        graceMs: command.graceMs,
        mocks: command.mocks,
        ...(io.env.WORKFLOW_TOKEN ? { token: io.env.WORKFLOW_TOKEN } : {}),
        ...(io.env.WORKFLOW_APP_TOKEN ? { appToken: io.env.WORKFLOW_APP_TOKEN } : {}),
        ...(credentials ? { credentials } : {}),
      },
      {
        browser,
        log: io.out,
        warn: io.err,
        onReady: (control) => {
          onInterrupt = () => {
            if (sigint) {
              // A second Ctrl-C is the escape hatch: the first waits for the
              // run to actually end, which is the whole point, but a harness
              // that will not answer must not hold the terminal hostage.
              closeAndExit(browser, io, 'SIGINT again — leaving without waiting', state)
              return
            }
            sigint = true
            io.err('SIGINT — clicking Cancel; waiting for the run to end')
            void control.cancel()
          }
        },
      },
    )

    announce(report, io)
    return exitFor(report, sigint)
  } finally {
    await browser.close().catch(() => {})
  }
}

/**
 * `resume` has no run page to Cancel until it has adopted one, and a run it
 * never adopted is one it must not touch — so unlike `run` it keeps the
 * close-and-leave handler throughout. An interrupted resume leaves the run
 * where it was: the lease it took lapses on its own within a minute, and the
 * next `resume` picks it up.
 */
async function doResume(command: ResumeCommand, io: CliIo, state: Interrupt): Promise<ExitCode> {
  const credentials = command.mocks ? undefined : credentialsFromEnv(io.env)
  const browser = await (io.launch ?? launchBrowser)({ headed: command.headed })
  io.onSigint?.(() => closeAndExit(browser, io, 'SIGINT — closing the browser', state))

  try {
    const report = await resumeRun(
      {
        harnessUrl: command.harnessUrl,
        runId: command.runId,
        ...(command.out === undefined ? {} : { out: command.out }),
        timeoutMs: command.timeoutMs,
        graceMs: command.graceMs,
        mocks: command.mocks,
        ...(io.env.WORKFLOW_TOKEN ? { token: io.env.WORKFLOW_TOKEN } : {}),
        ...(io.env.WORKFLOW_APP_TOKEN ? { appToken: io.env.WORKFLOW_APP_TOKEN } : {}),
        ...(credentials ? { credentials } : {}),
      },
      { browser, log: io.out, warn: io.err },
    )

    announce(report, io)
    return exitFor(report, false)
  } finally {
    await browser.close().catch(() => {})
  }
}

async function doRuns(command: RunsCommand, io: CliIo, state: Interrupt): Promise<ExitCode> {
  const credentials = command.mocks ? undefined : credentialsFromEnv(io.env)
  const browser = await (io.launch ?? launchBrowser)({})
  // `runs` never has a run page, so this is its only SIGINT handling — without
  // it the whole command is a window where Ctrl-C orphans a Chromium.
  io.onSigint?.(() => closeAndExit(browser, io, 'SIGINT — closing the browser', state))
  const base = command.harnessUrl
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    if (credentials) await loginViaRelay(page, base, credentials)
    else await page.goto(`${base}/?mocks=on`, { waitUntil: 'networkidle' })

    const api = pageApi(page, {
      base,
      ...(io.env.WORKFLOW_TOKEN ? { token: io.env.WORKFLOW_TOKEN } : {}),
      ...(io.env.WORKFLOW_APP_TOKEN ? { appToken: io.env.WORKFLOW_APP_TOKEN } : {}),
    })
    io.out(formatRunsTable(await listRuns(api, command.impl, command.workflow, command.last)))
    return EXIT.OK
  } finally {
    await browser.close().catch(() => {})
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  if (argv.length === 0) {
    io.err(USAGE)
    return EXIT.USAGE
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out(USAGE)
    return EXIT.OK
  }

  const state: Interrupt = { leaving: false }
  try {
    const command = parseArgs(argv)
    return command.command === 'run'
      ? await doRun(command, io, state)
      : command.command === 'runs'
        ? await doRuns(command, io, state)
        : await doResume(command, io, state)
  } catch (error) {
    // A Ctrl-C that closed the browser aborts the in-flight call; that
    // exception is the interrupt's own wake, not a fault to report.
    if (state.leaving) return EXIT.SIGINT
    if (error instanceof UsageError) {
      io.err(`error: ${error.message}`)
      io.err(USAGE)
      return EXIT.USAGE
    }
    if (error instanceof DriverError) {
      io.err(`error: ${error.message}`)
      return error.code
    }
    // Never EXIT.FAILED: an exception the driver did not expect is a driver
    // fault, and `errors.ts` forbids it looking like a run that ran and
    // failed. The stack still goes out — this is the case nobody predicted.
    io.err(`driver error: ${(error as Error).stack ?? String(error)}`)
    return EXIT.USAGE
  }
}

/** realpathSync, tolerant of a path that doesn't resolve (falls back to itself). */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// Only run when invoked as a script (not when imported by tests). A published
// `bin` is launched through a symlink (npm) or shim (pnpm) — Node resolves the
// main module through the link, so import.meta.url is already the realpath
// while process.argv[1] is still the link path. Compare realpaths on both
// sides, or this guard is false for every `bin` invocation and the CLI
// silently no-ops (the lesson workflow-lint@1.0.0 learned in production).
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) {
  const code = await runCli(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env: process.env,
    onSigint: (handler) => process.on('SIGINT', handler),
    forceExit: (code) => process.exit(code),
  })
  process.exitCode = code
}
