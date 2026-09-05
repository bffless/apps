/**
 * The exit-code contract (Decision 13), driven end to end.
 *
 * These are the codes CI branches on, so they are pinned through the real
 * `runCli` → `doRun` → `runWorkflow` path rather than against a stubbed
 * report: the mapping is only true if the flow that produces the report agrees
 * with it. `runCli` was built injectable for exactly this — `launch`,
 * `onSigint` and `forceExit` are the only things replaced, and `launch` hands
 * back a page, not a driver.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import { runCli, type CliIo } from '../src/cli.js'
import { EXIT } from '../src/errors.js'
import { fakeBrowser, helloRoutes, type FakeOptions } from './fakes.js'

const inputsFile = (() => {
  const path = join(mkdtempSync(join(tmpdir(), 'wfh-cli-')), 'inputs.json')
  writeFileSync(path, '{}')
  return path
})()

const argv = (...extra: string[]) => [
  'run',
  'https://harness.test',
  'hello/demo',
  '--inputs',
  inputsFile,
  '--mocks',
  ...extra,
]

/** An io whose `launch` hands back the scripted fake page. */
function withBrowser(options: FakeOptions) {
  const { browser, page } = fakeBrowser(options)
  const recorded = {
    out: [] as string[],
    err: [] as string[],
    forced: [] as number[],
  }
  let sigint = () => {}
  const cliIo: CliIo = {
    out: (line) => recorded.out.push(line),
    err: (line) => recorded.err.push(line),
    env: {} as NodeJS.ProcessEnv,
    launch: async () => browser,
    onSigint: (handler) => {
      sigint = handler
    },
    forceExit: (code) => recorded.forced.push(code),
  }
  return { io: cliIo, page, ...recorded, raise: () => sigint() }
}

const ended = (status: string) => ({
  globals: [{ runId: 'run_1', status }],
  routes: helloRoutes(status),
})

describe('exit codes', () => {
  test('a run that succeeded is 0', async () => {
    const h = withBrowser(ended('succeeded'))
    expect(await runCli(argv(), h.io)).toBe(EXIT.OK)
    expect(h.out).toContain('succeeded: run_1')
  })

  test('a run that failed is 1 — the run ran, the work did not', async () => {
    const h = withBrowser(ended('failed'))
    expect(await runCli(argv(), h.io)).toBe(EXIT.FAILED)
    expect(h.err).toContain('failed: run_1')
  })

  test('a run that was cancelled without a SIGINT is 1', async () => {
    const h = withBrowser(ended('cancelled'))
    expect(await runCli(argv(), h.io)).toBe(EXIT.FAILED)
  })

  test('a run cancelled after a SIGINT is 130, and Cancel really was clicked', async () => {
    // The signal is raised on the poll *after* the run page came up, which is
    // the only window where the CLI's handler has been upgraded from
    // close-and-leave to click-Cancel-and-wait.
    let raise = () => {}
    const h = withBrowser({
      globals: [{ runId: 'run_1', status: 'running' }, { runId: 'run_1', status: 'cancelled' }],
      routes: helloRoutes('cancelled'),
      onGlobalRead: (n) => {
        if (n === 2) raise()
      },
    })
    raise = h.raise

    expect(await runCli(argv(), h.io)).toBe(EXIT.SIGINT)
    expect(h.page.clicks).toEqual(['[data-testid="run-cancel"]'])
    // Not the second-Ctrl-C escape hatch: nothing forced an exit.
    expect(h.forced).toEqual([])
  })

  test('a start that never settles is 4, not 1', async () => {
    const h = withBrowser({ globals: [undefined], routes: helloRoutes('succeeded') })
    const code = await runCli(argv('--timeout', '50ms'), h.io)
    expect(code).toBe(EXIT.TIMEOUT)
    expect(code).not.toBe(EXIT.FAILED)
  })

  /**
   * A parked run is not a failure: the work got as far as it could without a
   * person, and the id in the line is what the human (or the later `resume`)
   * needs. CI must be able to treat it as a clean end, so it is 0.
   */
  test('a run that parked is 0, and says what it waits on', async () => {
    const h = withBrowser({
      globals: [
        { runId: 'run_1', status: 'running' },
        { runId: 'run_1', status: 'parked', currentSteps: ['ask/0/answer'] },
      ],
      routes: helloRoutes('running'),
    })
    expect(await runCli(argv('--wait', 'park', '--grace', '1ms'), h.io)).toBe(EXIT.OK)
    expect(h.out).toContain('parked: run_1 (ask/0/answer)')
  })

  /**
   * 5, and nothing else: a `resume` that lost the lease did no work at all, so
   * it must not look like a run that failed (1) or like a driver that broke
   * (2). CI retries this one; it does not report it.
   */
  test('a resume that found the lease held is 5', async () => {
    const runId = 'run_01M1BREJZK5V77ZRPXKTG7ZG7C'
    const h = withBrowser({
      globals: [{ runId, status: 'busy' }],
      routes: helloRoutes('running', runId),
    })
    const code = await runCli(['resume', 'https://harness.test', runId, '--mocks'], h.io)
    expect(code).toBe(EXIT.BUSY)
    expect(code).not.toBe(EXIT.FAILED)
    expect(h.err).toContain(`busy: ${runId}`)
  })

  test('a resume drives the run home and is 0', async () => {
    const runId = 'run_01M1BREJZK5V77ZRPXKTG7ZG7C'
    const h = withBrowser({
      globals: [
        { runId, status: 'running' },
        { runId, status: 'succeeded' },
      ],
      routes: helloRoutes('succeeded', runId),
    })
    // The record already says `succeeded`, so this is the "nothing to resume"
    // path: reported at its own status, without taking a lease on it.
    expect(await runCli(['resume', 'https://harness.test', runId, '--mocks'], h.io)).toBe(EXIT.OK)
    expect(h.out).toContain(`succeeded: ${runId}`)
    expect(h.page.gotos.some((url) => url.includes('resume=1'))).toBe(false)
  })

  test('a usage error is 2, and prints the usage', async () => {
    const h = withBrowser(ended('succeeded'))
    expect(await runCli(['run', 'https://harness.test', 'hello/demo'], h.io)).toBe(EXIT.USAGE)
    expect(h.err.join('\n')).toContain('--inputs is required')
    expect(h.err.join('\n')).toContain('Usage: workflow-headless run')
    // No argv at all is the same answer.
    expect(await runCli([], h.io)).toBe(EXIT.USAGE)
  })

  test('an unexpected exception is the driver-side code, never 1', async () => {
    const h = withBrowser(ended('succeeded'))
    const code = await runCli(argv(), {
      ...h.io,
      launch: async () => {
        throw new Error('chromium is not installed')
      },
    })
    expect(code).toBe(EXIT.USAGE)
    expect(code).not.toBe(EXIT.FAILED)
    expect(h.err.join('\n')).toContain('driver error: Error: chromium is not installed')
  })
})
