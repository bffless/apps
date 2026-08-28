import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

/**
 * 07's headless contract, end to end: the built `workflow-headless` CLI drives
 * the very harness Playwright is already serving on `baseURL`, in its own
 * Chromium, and everything asserted here is read back off disk — the exit code,
 * `run.json`, `steps.log`, the downloaded outputs. Nothing of the driver is
 * re-implemented or stubbed; this is the smoke a CI dispatch would run, pointed
 * at the mock backend instead of a deployment.
 *
 * The driver launches a browser of its own, so this spec deliberately asks for
 * no `page` fixture: Playwright's worker never opens one, and the two browsers
 * never share a profile.
 */
const CLI = fileURLToPath(new URL('../../../packages/workflow-headless/dist/cli.js', import.meta.url))

/**
 * Never skip. A missing `dist/cli.js` means the CI order regressed (the driver
 * build must precede the e2e step — see `.github/workflows/workflow-app.yml`),
 * and a skipped smoke would report that as green.
 */
test.beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(
      `workflow-headless is not built: ${CLI} is missing.\n` +
        'Run `pnpm --filter @bffless/workflow-headless build` before `pnpm --filter workflow test:e2e`.',
    )
  }
})

interface DriverResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Three ceilings, deliberately nested, so a hang is diagnosed by the innermost
 * one that can say something useful:
 *
 * 1. the driver's own — `--timeout 90s` bounds the wait for a run id *and*
 *    again the wait for a terminal status (`run.ts` caps the first at 120 s),
 *    so ~180 s plus a browser launch. Reaching it is exit 4 with `failed.png`
 *    and `steps.log` on disk: the diagnostic CI actually needs;
 * 2. this backstop — the driver is out of excuses, so kill it rather than
 *    orphan it under a timed-out test. SIGTERM, not SIGKILL: Playwright's own
 *    handler closes the browser on it, so no headless Chromium is left behind;
 * 3. `test.setTimeout` in each test, above both — Playwright timing out first
 *    is the one outcome that tells us nothing.
 */
const DRIVER_TIMEOUT = '90s'
const BACKSTOP_MS = 240_000
const TEST_TIMEOUT_MS = 300_000

/** Runs the CLI to completion and hands back its exit code — never throws on one. */
function drive(args: string[]): Promise<DriverResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { maxBuffer: 32 * 1024 * 1024, timeout: BACKSTOP_MS, killSignal: 'SIGTERM' },
      (error, stdout, stderr) => {
        // `error.code` is the exit code; anything else means the child never
        // reached one — a fault of this harness, not a verdict from the driver.
        if (error && typeof error.code !== 'number') {
          const why = error.killed
            ? `the driver did not finish within ${BACKSTOP_MS} ms, so it was terminated ` +
              `(its own ${DRIVER_TIMEOUT} ceiling should have fired first)`
            : `the driver did not exit normally: ${error.message}`
          reject(new Error(`${why}\n${stdout}\n${stderr}`))
          return
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr })
      },
    )
  })
}

/**
 * `steps.log` is `<iso>\t<key>\t<status>` — the statuses the driver's 1 s
 * sampler *saw*, in order. A step that came and went inside one tick leaves no
 * line, so this is the ordering narrative, never proof that a status did not
 * occur; `run.json` is where a step's settled status is read from.
 */
function transitionsFor(out: string, key: string): string[] {
  return readFileSync(join(out, 'steps.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, logged]) => logged === key)
    .map(([, , status]) => status)
}

test('the headless driver runs interactive hello unattended and writes its artifacts', async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(TEST_TIMEOUT_MS)
  const out = testInfo.outputPath('run')
  const inputs = testInfo.outputPath('inputs.json')
  writeFileSync(inputs, JSON.stringify({ greeting: 'Hello', names: ['world', 'studio'] }))

  const result = await drive([
    'run',
    baseURL!,
    'hello/interactive',
    '--inputs',
    inputs,
    '--mocks',
    '--out',
    out,
    '--timeout',
    DRIVER_TIMEOUT,
  ])
  expect(result.code, `driver failed:\n${result.stdout}\n${result.stderr}`).toBe(0)

  // The record, read from `/api/workflow/run?id=` — not scraped off the page.
  const record = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))
  expect(record.run.status).toBe('succeeded')
  // The row carries the fact that nobody was watching (07's page contract).
  expect(record.run.headless).toBe(true)

  // The two headless modes, read off the record rather than off the sampler:
  // every step the run reached has a row, whatever the 1 s poll happened to
  // catch in flight.
  const settled = (key: string): string | undefined =>
    (record.steps as { key: string; status: string }[]).find((s) => s.key === key)?.status
  // `headless: auto` — the run page opened the island itself and the island
  // submitted over `workflow.submit`; no chip was ever clicked.
  expect(settled('pick/0/choose')).toBe('succeeded')
  // `headless: { mode: skip, … }` — the step took its literal outputs instead
  // of waiting for a person.
  expect(settled('review/0/confirm')).toBe('skipped')

  // And the sampler agrees about where each ended up. This is the ordering
  // narrative; it cannot prove a status *never* occurred, and does not try.
  expect(transitionsFor(out, 'pick/0/choose').at(-1)).toBe('succeeded')
  expect(transitionsFor(out, 'review/0/confirm').at(-1)).toBe('skipped')

  // The script step's Blob became a File ref, and the driver downloaded it.
  const poster = join(out, 'outputs', 'poster.svg')
  expect(existsSync(poster), 'outputs/poster.svg was not downloaded').toBe(true)
  expect(readFileSync(poster, 'utf8')).toContain('<svg')

  // The terminal-status screenshot is named after the status it caught.
  expect(existsSync(join(out, '02-succeeded.png'))).toBe(true)
})

test('the headless driver exits 3 when the page refuses the start', async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(TEST_TIMEOUT_MS)
  const out = testInfo.outputPath('run')
  const inputs = testInfo.outputPath('inputs.json')
  // `greeting` is declared `type: string`; a number is judged by the very same
  // validator the kickoff form's own Start runs.
  writeFileSync(inputs, JSON.stringify({ greeting: 5 }))

  const result = await drive([
    'run',
    baseURL!,
    'hello/interactive',
    '--inputs',
    inputs,
    '--mocks',
    '--out',
    out,
    '--timeout',
    DRIVER_TIMEOUT,
  ])

  // 3, not 1: nothing ran, so this is not a run that failed.
  expect(result.code, `expected a refused start:\n${result.stdout}\n${result.stderr}`).toBe(3)
  expect(result.stderr).toMatch(/invalid: greeting:/)
  // No run existed, so there is no record to write.
  expect(existsSync(join(out, 'run.json'))).toBe(false)
})
