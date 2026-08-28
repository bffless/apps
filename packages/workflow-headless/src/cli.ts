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
  type RunCommand,
  type RunsCommand,
} from './args.js'
import { launchBrowser } from './browser.js'
import { DriverError, EXIT, type ExitCode } from './errors.js'
import { loginViaRelay } from './login.js'
import type { BrowserLike } from './page.js'
import { formatRunsTable, listRuns } from './runs.js'
import { runWorkflow, type RunReport } from './run.js'

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

function exitFor(report: RunReport, sigint: boolean): ExitCode {
  if (report.status === 'invalid') return EXIT.INVALID
  if (report.status === 'succeeded') return EXIT.OK
  if (report.status === 'cancelled' && sigint) return EXIT.SIGINT
  return EXIT.FAILED
}

async function doRun(command: RunCommand, io: CliIo): Promise<ExitCode> {
  const inputs = loadInputs(command.inputsFile)
  const credentials = command.mocks ? undefined : credentialsFromEnv(io.env)
  const browser = await (io.launch ?? launchBrowser)({ headed: command.headed })

  let sigint = false
  let cancel: (() => Promise<void>) | undefined

  try {
    const report = await runWorkflow(
      {
        harnessUrl: command.harnessUrl,
        impl: command.impl,
        workflow: command.workflow,
        inputs,
        ...(command.out === undefined ? {} : { out: command.out }),
        timeoutMs: command.timeoutMs,
        mocks: command.mocks,
        ...(io.env.WORKFLOW_TOKEN ? { token: io.env.WORKFLOW_TOKEN } : {}),
        ...(credentials ? { credentials } : {}),
      },
      {
        browser,
        log: io.out,
        warn: io.err,
        onReady: (control) => {
          cancel = control.cancel
          io.onSigint?.(() => {
            if (sigint) {
              // A second Ctrl-C is the escape hatch: the first waits for the
              // run to actually end, which is the whole point, but a harness
              // that will not answer must not hold the terminal hostage.
              io.err('SIGINT again — leaving without waiting')
              void browser
                .close()
                .catch(() => {})
                .then(() => io.forceExit?.(EXIT.SIGINT))
              return
            }
            sigint = true
            io.err('SIGINT — clicking Cancel; waiting for the run to end')
            void cancel?.()
          })
        },
      },
    )

    if (report.status === 'succeeded') io.out(`succeeded: ${report.runId}`)
    else if (report.status !== 'invalid') io.err(`${report.status}: ${report.runId}`)
    for (const path of report.artifacts.written) io.out(`wrote ${path}`)
    return exitFor(report, sigint)
  } finally {
    await browser.close().catch(() => {})
  }
}

async function doRuns(command: RunsCommand, io: CliIo): Promise<ExitCode> {
  const credentials = command.mocks ? undefined : credentialsFromEnv(io.env)
  const browser = await (io.launch ?? launchBrowser)({})
  const base = command.harnessUrl
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    if (credentials) await loginViaRelay(page, base, credentials)
    else await page.goto(`${base}/?mocks=on`, { waitUntil: 'networkidle' })

    const api = pageApi(page, { base, ...(io.env.WORKFLOW_TOKEN ? { token: io.env.WORKFLOW_TOKEN } : {}) })
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

  try {
    const command = parseArgs(argv)
    return command.command === 'run' ? await doRun(command, io) : await doRuns(command, io)
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`error: ${error.message}`)
      io.err(USAGE)
      return EXIT.USAGE
    }
    if (error instanceof DriverError) {
      io.err(`error: ${error.message}`)
      return error.code
    }
    io.err(`driver error: ${(error as Error).stack ?? String(error)}`)
    return EXIT.FAILED
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
