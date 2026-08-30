import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseWalkArgs } from '../src/args.js'
import { parseRecord } from '../src/record.js'
import { Report } from '../src/report.js'
import { WALKS } from '../src/walks/index.js'

vi.mock('../src/driver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/driver.js')>()
  return { ...actual, driverCliPath: () => process.execPath, runDriver: vi.fn() }
})
vi.mock('../src/fixture.js', () => ({ ensureClip: vi.fn().mockResolvedValue({ path: '/clip.mp4', sha256: 'x' }) }))

import { runDriver } from '../src/driver.js'

const load = () => parseRecord(JSON.parse(readFileSync(new URL('./fixtures/studio-headless.json', import.meta.url), 'utf8')))
const env = { WORKFLOW_EMAIL: 'e', WORKFLOW_PASSWORD: 'p' }
const out = () => join(tmpdir(), 'workflow-live-test', `sh-${Math.random().toString(36).slice(2)}`)

beforeEach(() => { vi.mocked(runDriver).mockReset() })

describe('studioHeadless spend cap', () => {
  it('does not retry after a run failure (exit 1)', async () => {
    vi.mocked(runDriver).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'boom' })
    const report = new Report('studio-headless', 'h')
    const args = parseWalkArgs(['walk', 'studio-headless', '--out', out()])
    await WALKS['studio-headless']({ args, env, report })
    const r = report.finish()
    expect(r.spend.studioKickoffs).toBe(1)
    expect(r.checks['driver.exit0']?.pass).toBe(false)
    expect((r.checks['driver.exit0']?.evidence as { stderrTail: string }).stderrTail).toBe('boom')
  })

  it('retries once after a driver-fault (exit 2), then succeeds', async () => {
    const rec = load()   // a real headless run record (run.headless already true)
    vi.mocked(runDriver).mockResolvedValueOnce({ code: 2, stdout: '', stderr: '' }).mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', record: rec })
    const report = new Report('studio-headless', 'h')
    const args = parseWalkArgs(['walk', 'studio-headless', '--out', out()])
    await WALKS['studio-headless']({ args, env, report })
    const r = report.finish()
    expect(r.spend.studioKickoffs).toBe(2)
    expect(r.checks['driver.exit0']?.pass).toBe(true)
  })

  it('caps at 2 kickoffs and blocks after repeated driver faults', async () => {
    vi.mocked(runDriver).mockResolvedValueOnce({ code: 2, stdout: '', stderr: '' }).mockResolvedValueOnce({ code: 2, stdout: '', stderr: '' })
    const report = new Report('studio-headless', 'h')
    const args = parseWalkArgs(['walk', 'studio-headless', '--out', out()])
    await WALKS['studio-headless']({ args, env, report })
    const r = report.finish()
    expect(r.spend.studioKickoffs).toBe(2)
    expect(typeof r.blocked).toBe('string')
  })
})
