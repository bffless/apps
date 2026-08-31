import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import { EXIT } from '../src/errors.js'
import { runWorkflow } from '../src/run.js'
import { fakeBrowser, helloRoutes } from './fakes.js'

const out = () => mkdtempSync(join(tmpdir(), 'wfh-run-'))

const options = (timeoutMs: number, dir?: string) => ({
  harnessUrl: 'https://harness.test',
  impl: 'hello',
  workflow: 'demo',
  inputs: {},
  ...(dir === undefined ? {} : { out: dir }),
  timeoutMs,
  mocks: true,
})

describe('runWorkflow — a start that never settles', () => {
  /**
   * Exit 4 before a run id exists is the un-diagnosable case: every refusal the
   * page can explain arrives as `invalid`, so if the start timeout wrote
   * nothing there would be no evidence at all of an auth bounce loop or a run
   * page that threw. The artifacts are the whole diagnosis.
   */
  test('still writes failed.png, console.log and steps.log before it throws', async () => {
    const dir = out()
    const { browser, page } = fakeBrowser({
      globals: [undefined],
      routes: helloRoutes('succeeded'),
      consoleLines: ['error: Uncaught TypeError: cannot read properties of undefined'],
    })

    await expect(
      runWorkflow(options(50, dir), { browser, log: () => {}, warn: () => {} }),
    ).rejects.toMatchObject({ code: EXIT.TIMEOUT })

    expect(existsSync(join(dir, 'failed.png'))).toBe(true)
    expect(readFileSync(join(dir, 'console.log'), 'utf8')).toContain('Uncaught TypeError')
    // Empty, because nothing ever transitioned — but present, so the artifact
    // set a passing run leaves and a start-timeout leaves are the same shape.
    expect(readFileSync(join(dir, 'steps.log'), 'utf8')).toBe('')
    // Not the milestone shot: the start never settled.
    expect(page.screenshots.map((p) => p.split('/').pop())).toEqual(['failed.png'])
  })

  test('writes nothing when there is no --out to write to', async () => {
    const { browser, page } = fakeBrowser({ globals: [undefined], routes: helloRoutes('succeeded') })

    await expect(
      runWorkflow(options(50), { browser, log: () => {}, warn: () => {} }),
    ).rejects.toMatchObject({ code: EXIT.TIMEOUT })

    expect(page.screenshots).toEqual([])
  })
})

describe('runWorkflow — a login that never returns', () => {
  /**
   * The relay login is the driver's least-covered path — `--mocks` skips it
   * entirely — and it runs before any artifact exists, so its first live
   * failure (a GitHub runner, 2026-08-28) produced an empty `output/` and no
   * way to tell a bot challenge from a wrong password. What the browser is
   * *looking at* is the whole diagnosis, so it goes into both the message and
   * the artifacts.
   */
  test('captures the page it is stuck on, in the error and on disk', async () => {
    const dir = out()
    const { browser, page } = fakeBrowser({
      globals: [undefined],
      routes: helloRoutes('succeeded'),
      login: 'stuck',
      pageText: 'Just a moment… | Checking your browser before accessing workflow.j5s.dev',
      consoleLines: ['error: challenge script'],
    })

    const live = { ...options(50, dir), mocks: false, credentials: { email: 'a@b.c', password: 'x' } }

    // One call, not two: a second run into the same `--out` would rewrite the
    // very console.log this asserts on.
    const error = await runWorkflow(live, { browser, log: () => {}, warn: () => {} }).then(
      () => null,
      (thrown: unknown) => thrown as { code: number; message: string },
    )

    expect(error?.code).toBe(EXIT.USAGE)
    // The URL it is stuck on and the page's own words — enough to tell a
    // challenge from a refusal without re-running anything.
    expect(error?.message).toContain('https://admin.test/login')
    expect(error?.message).toContain('Checking your browser')

    expect(existsSync(join(dir, 'failed.png'))).toBe(true)
    expect(readFileSync(join(dir, 'console.log'), 'utf8')).toContain('challenge script')
    expect(page.clicks).toContain('button[type="submit"]')
  })
})

describe('runWorkflow — a record that seals after the page does', () => {
  /**
   * The page's terminal pill and the run record's status are written by two
   * different actors: the pill by the run page's render, the record by the
   * SPA's sealing `POST /api/workflow/run/update` — which #539 made
   * `keepalive`, a promise that survives a tab close but not `browser.close()`
   * of the whole process. The live `headless` walk of 2026-08-30 proved the
   * window: the driver saw "Succeeded", exited 0, and left
   * run_01M1BREJZK5V77ZRPXKTG7ZG7C `running` forever. So after the page shows
   * terminal, the driver must hold the browser open until the *record* agrees.
   */
  const key = '/api/workflow/run?id=run_1'
  const record = (status: string) => ({
    status: 200,
    text: JSON.stringify({ run: { runId: 'run_1', status, outputs: {} }, steps: [] }),
  })
  const globals = [
    { runId: 'run_1', status: 'running' },
    { runId: 'run_1', status: 'succeeded' },
  ]

  test('polls the record until it reports a terminal status, and run.json carries it', async () => {
    const dir = out()
    const routes = helloRoutes('succeeded')
    routes[key] = [record('running'), record('running'), record('running'), record('succeeded')]
    const { browser, page } = fakeBrowser({ globals, routes })

    const report = await runWorkflow(options(5_000, dir), {
      browser,
      log: () => {},
      warn: () => {},
      sleep: async () => {},
    })

    expect(report.status).toBe('succeeded')
    // The record was re-read until it sealed — not snapshotted mid-race.
    expect(page.fetched.filter((k) => k === key).length).toBeGreaterThanOrEqual(4)
    const written = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as {
      run: { status: string }
    }
    expect(written.run.status).toBe('succeeded')
  })

  test('waits for the seal even with no --out — closing early is the race itself', async () => {
    const routes = helloRoutes('succeeded')
    routes[key] = [record('running'), record('succeeded')]
    const { browser, page } = fakeBrowser({ globals, routes })

    const report = await runWorkflow(options(5_000), {
      browser,
      log: () => {},
      warn: () => {},
      sleep: async () => {},
    })

    expect(report.status).toBe('succeeded')
    expect(page.fetched.filter((k) => k === key).length).toBeGreaterThanOrEqual(2)
  })

  test('a record that never seals: bounded, warned, freshest read written, page status kept', async () => {
    const dir = out()
    const routes = helloRoutes('succeeded')
    routes[key] = record('running')
    const { browser } = fakeBrowser({ globals, routes })

    const warns: string[] = []
    const report = await runWorkflow(options(5_000, dir), {
      browser,
      log: () => {},
      warn: (line) => warns.push(line),
      sleep: async () => {},
    })

    // The exit vocabulary is untouched: the page saw `succeeded`, so the
    // report says `succeeded` — the unsealed record is a warning, not a code.
    expect(report.status).toBe('succeeded')
    expect(warns.some((line) => line.includes('run_1') && line.includes('running'))).toBe(true)
    const written = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as {
      run: { status: string }
    }
    expect(written.run.status).toBe('running')
  })
})
