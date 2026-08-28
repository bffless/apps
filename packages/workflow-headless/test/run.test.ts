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
