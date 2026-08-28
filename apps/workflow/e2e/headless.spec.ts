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

/** Runs the CLI to completion and hands back its exit code — never throws on one. */
function drive(args: string[]): Promise<DriverResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // `error.code` is the exit code; a `signal` instead means the child was
        // killed, which is a fault of this harness rather than a driver verdict.
        if (error && typeof error.code !== 'number') {
          reject(new Error(`the driver did not exit normally: ${error.message}`))
          return
        }
        resolve({ code: error ? (error.code as number) : 0, stdout, stderr })
      },
    )
  })
}

/** `steps.log` is `<iso>\t<key>\t<status>` — every status a key passed through, in order. */
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
  test.setTimeout(180_000)
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
    '90s',
  ])
  expect(result.code, `driver failed:\n${result.stdout}\n${result.stderr}`).toBe(0)

  // The record, read from `/api/workflow/run?id=` — not scraped off the page.
  const record = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))
  expect(record.run.status).toBe('succeeded')
  // The row carries the fact that nobody was watching (07's page contract).
  expect(record.run.headless).toBe(true)

  // `pick/0/choose` is `headless: auto`: the run page opened the island itself
  // and the island submitted over `workflow.submit` — no chip was ever clicked.
  const choose = transitionsFor(out, 'pick/0/choose')
  expect(choose, `pick/0/choose never settled: ${choose.join(' → ')}`).toContain('succeeded')
  expect(choose.at(-1)).toBe('succeeded')

  // `review/0/confirm` is `headless: { mode: skip, … }`: skipped without ever
  // being queued. A `waiting` here is the hang the mode exists to prevent.
  const confirm = transitionsFor(out, 'review/0/confirm')
  expect(confirm, `review/0/confirm never settled: ${confirm.join(' → ')}`).toContain('skipped')
  expect(confirm).not.toContain('waiting')

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
  test.setTimeout(180_000)
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
    '90s',
  ])

  // 3, not 1: nothing ran, so this is not a run that failed.
  expect(result.code, `expected a refused start:\n${result.stdout}\n${result.stderr}`).toBe(3)
  expect(result.stderr).toMatch(/invalid: greeting:/)
  // No run existed, so there is no record to write.
  expect(existsSync(join(out, 'run.json'))).toBe(false)
})
