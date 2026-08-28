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
