/**
 * `resume` — the other half of `--wait park`.
 *
 * Driven through the real `resumeRun` against the same fake page the run tests
 * use, because what is being pinned is a *sequence* against a live record: read
 * the record to find out which workflow this id belongs to, open that run page
 * with `resume=1`, and only then follow. A stub of any of those three would
 * pin nothing.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import { EXIT } from '../src/errors.js'
import { resumeRun } from '../src/resume.js'
import { fakeBrowser, type Route } from './fakes.js'

const RUN_ID = 'run_1'
const RECORD = `/api/workflow/run?id=${RUN_ID}`
const RUN_URL = 'https://harness.test/hello/demo/runs/run_1'
/** What the driver *opens*; the report says `RUN_URL`, the page a person would want. */
const RESUME_URL = `${RUN_URL}?resume=1&wait=park`

const out = () => mkdtempSync(join(tmpdir(), 'wfh-resume-'))

const record = (status: string, over: Record<string, unknown> = {}): Route => ({
  status: 200,
  text: JSON.stringify({
    run: {
      runId: RUN_ID,
      status,
      impl: 'hello',
      workflow: 'demo',
      leaseOwner: null,
      leaseUntil: null,
      outputs: {},
      ...over,
    },
    steps: [{ key: 'ask/0/answer', status: status === 'running' ? 'waiting' : 'succeeded' }],
  }),
})

const options = (over: Record<string, unknown> = {}) => ({
  harnessUrl: 'https://harness.test',
  runId: RUN_ID,
  timeoutMs: 5_000,
  graceMs: 0,
  mocks: true,
  ...over,
})

describe('resumeRun', () => {
  test('finds the run page from the record, adopts it and follows the run home', async () => {
    const { browser, page } = fakeBrowser({
      // The pre-flight read finds a running run; the second is the seal check.
      routes: { [RECORD]: [record('running'), record('succeeded')] },
      globals: [
        { runId: RUN_ID, status: 'running' },
        { runId: RUN_ID, status: 'succeeded' },
      ],
    })

    const report = await resumeRun(options(), {
      browser,
      log: () => {},
      warn: () => {},
      sleep: async () => {},
    })

    // A run id alone does not say which page to open — `impl`/`workflow` off
    // the record do, and `resume=1` is what makes the page adopt the lease
    // without a person clicking Resume.
    expect(page.gotos).toContain(RESUME_URL)
    expect(report).toMatchObject({ runId: RUN_ID, status: 'succeeded', url: RUN_URL })
  })

  test('a lease held elsewhere is `busy` — nothing was driven', async () => {
    const { browser, page } = fakeBrowser({
      routes: { [RECORD]: record('running') },
      globals: [{ runId: RUN_ID, status: 'busy' }],
    })

    const report = await resumeRun(options(), { browser, log: () => {}, warn: () => {}, sleep: async () => {} })

    expect(page.gotos).toContain(RESUME_URL)
    expect(report.status).toBe('busy')
    // No outputs were downloaded off a run this driver never drove.
    expect(report.artifacts.written).toEqual([])
  })

  test('a resumed run can park again, and says so', async () => {
    const dir = out()
    const { browser } = fakeBrowser({
      routes: { [RECORD]: record('running') },
      globals: [
        { runId: RUN_ID, status: 'running' },
        { runId: RUN_ID, status: 'parked', currentSteps: ['ask/1/sign'] },
      ],
    })

    const report = await resumeRun(options({ out: dir }), {
      browser,
      log: () => {},
      warn: () => {},
      sleep: async () => {},
    })

    expect(report).toMatchObject({ status: 'parked', parkedOn: ['ask/1/sign'] })
    expect(existsSync(join(dir, 'run.json'))).toBe(true)
    expect(readFileSync(join(dir, 'console.log'), 'utf8')).toBe('')
  })

  test('a run that already ended is reported, not re-opened', async () => {
    const dir = out()
    const { browser, page } = fakeBrowser({
      routes: { [RECORD]: record('succeeded', { outputs: { note: 'done' } }) },
      globals: [undefined],
    })

    const report = await resumeRun(options({ out: dir }), {
      browser,
      log: () => {},
      warn: () => {},
      sleep: async () => {},
    })

    expect(report.status).toBe('succeeded')
    // Only the `?mocks=on` visit that arms the mock backend: there is nothing
    // to adopt on a run that is over, and opening it would just take a lease
    // on a finished run.
    expect(page.gotos).toEqual(['https://harness.test/?mocks=on'])
    const written = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as {
      run: { status: string }
    }
    expect(written.run.status).toBe('succeeded')
  })

  test('a record that cannot be read is a driver fault, not a run that failed', async () => {
    const { browser } = fakeBrowser({ routes: {}, globals: [undefined] })

    await expect(
      resumeRun(options(), { browser, log: () => {}, warn: () => {}, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: EXIT.USAGE })
  })
})
