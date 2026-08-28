/**
 * argv → a command, or a `UsageError` (exit 2). Everything here is pure and
 * synchronous so the whole surface is unit-testable without a browser.
 */
import { readFileSync } from 'node:fs'

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export const USAGE = `Usage: workflow-headless run <harness-url> <impl>/<workflow> --inputs <file.json> [options]
       workflow-headless runs <harness-url> <impl>/<workflow> [--last 10]

Runs one Workflow harness workflow unattended: a headless Chromium opens
<harness-url>/<impl>/<workflow>/run?auto=1&inputs=…, follows the run through
window.__workflow, and writes the record and its file outputs to --out.

Options (run):
  --inputs <file>   JSON object of kickoff values, keyed by the names in
                    on.manual.inputs. A \`file\` input's value is a local path:
                    it is uploaded (prepare -> PUT -> register) and replaced by
                    the File ref before the page opens. A workflow that takes
                    no inputs still needs a file containing {}.
  --out <dir>       where run.json, outputs/, steps.log, console.log and the
                    milestone screenshots are written (default: no artifacts)
  --timeout <60m>   how long to wait for a terminal status (default 60m;
                    ms/s/m/h suffixes, a bare number is seconds)
  --mocks           drive the dev harness's MSW mock backend (adds &mocks=on)
                    and skip the login
  --headed          show the browser, for debugging

Options (runs):
  --last <n>        how many past runs to list (default 10)
  --mocks           list the mock harness's runs, and skip the login

Environment:
  WORKFLOW_EMAIL / WORKFLOW_PASSWORD   the member login the harness relays
                                       (required unless --mocks)
  WORKFLOW_TOKEN                       optional X-API-Key, added to
                                       /api/workflow/* reads

Exit codes: 0 succeeded · 1 failed/cancelled · 2 usage/auth · 3 invalid inputs
            · 4 driver timeout · 130 SIGINT (Cancel clicked)`

export interface RunCommand {
  command: 'run'
  harnessUrl: string
  impl: string
  workflow: string
  inputsFile: string
  out?: string
  timeoutMs: number
  mocks: boolean
  headed: boolean
}

export interface RunsCommand {
  command: 'runs'
  harnessUrl: string
  impl: string
  workflow: string
  last: number
  mocks: boolean
}

export type Command = RunCommand | RunsCommand

const DURATION = /^(-?\d+(?:\.\d+)?)(ms|s|m|h)?$/

/** `90m` → ms. A bare number is seconds, which is what a `--timeout 300` means to everyone. */
export function parseDuration(text: string): number {
  const match = DURATION.exec(text.trim())
  if (!match) throw new UsageError(`--timeout: not a duration: ${text}`)
  const amount = Number(match[1])
  const unit = match[2] ?? 's'
  const scale = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
  const ms = Math.round(amount * scale)
  if (!(ms > 0)) throw new UsageError(`--timeout: must be positive: ${text}`)
  return ms
}

function value(argv: string[], i: number, flag: string): string {
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`)
  return next
}

function splitRef(ref: string | undefined): { impl: string; workflow: string } {
  const parts = (ref ?? '').split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new UsageError(`expected <impl>/<workflow>, got: ${ref ?? '(nothing)'}`)
  }
  return { impl: parts[0]!, workflow: parts[1]! }
}

function harness(url: string | undefined): string {
  if (url === undefined) throw new UsageError('a harness url is required')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UsageError(`not a url: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`the harness url must be http(s): ${url}`)
  }
  return url.replace(/\/+$/, '')
}

export function parseArgs(argv: string[]): Command {
  const verb = argv[0]
  if (verb !== 'run' && verb !== 'runs') {
    throw new UsageError(verb === undefined ? 'a command is required' : `unknown command: ${verb}`)
  }

  const harnessUrl = harness(argv[1])
  const { impl, workflow } = splitRef(argv[2])

  if (verb === 'runs') {
    let last = 10
    let listMocks = false
    for (let i = 3; i < argv.length; i += 1) {
      const flag = argv[i]!
      if (flag === '--last') {
        const n = Number(value(argv, i, '--last'))
        if (!Number.isInteger(n) || n <= 0) throw new UsageError('--last: expected a positive integer')
        last = n
        i += 1
      } else if (flag === '--mocks') listMocks = true
      else throw new UsageError(`unknown option: ${flag}`)
    }
    return { command: 'runs', harnessUrl, impl, workflow, last, mocks: listMocks }
  }

  let inputsFile: string | undefined
  let out: string | undefined
  let timeoutMs = 60 * 60_000
  let mocks = false
  let headed = false

  for (let i = 3; i < argv.length; i += 1) {
    const flag = argv[i]!
    if (flag === '--inputs') {
      inputsFile = value(argv, i, '--inputs')
      i += 1
    } else if (flag === '--out') {
      out = value(argv, i, '--out')
      i += 1
    } else if (flag === '--timeout') {
      timeoutMs = parseDuration(value(argv, i, '--timeout'))
      i += 1
    } else if (flag === '--mocks') mocks = true
    else if (flag === '--headed') headed = true
    else throw new UsageError(`unknown option: ${flag}`)
  }

  if (inputsFile === undefined) {
    throw new UsageError('--inputs is required (a workflow with no inputs still needs a file containing {})')
  }

  return {
    command: 'run',
    harnessUrl,
    impl,
    workflow,
    inputsFile,
    ...(out === undefined ? {} : { out }),
    timeoutMs,
    mocks,
    headed,
  }
}

/**
 * The `--inputs` file. A missing or malformed one is a *usage* error (2), not a
 * refused start (3): the page never saw it, so nothing about the workflow is
 * being reported here.
 */
export function loadInputs(path: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new UsageError(`--inputs: cannot read ${path}: ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new UsageError(`--inputs: ${path} is not valid JSON: ${(error as Error).message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`--inputs: ${path} must contain a JSON object of input values`)
  }
  return parsed as Record<string, unknown>
}

/** The login the harness relay needs, from the environment (Decision 13). */
export function credentialsFromEnv(env: NodeJS.ProcessEnv): { email: string; password: string } {
  const email = env.WORKFLOW_EMAIL
  const password = env.WORKFLOW_PASSWORD
  if (!email || !password) {
    throw new UsageError('WORKFLOW_EMAIL and WORKFLOW_PASSWORD are required (or pass --mocks)')
  }
  return { email, password }
}
