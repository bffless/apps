import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { setupServer } from 'msw/node'
import { installMswRelativeUrlShim } from '../test/mswRequestShim'
import { toServerSheets, toServerFrames } from '../lib/serverFrames'

// MOCK_STUDIO is resolved at module load, so each case re-imports the module
// with a fresh env.
describe('studio mock gate', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllEnvs())

  it('includes studio handlers only when VITE_MOCK_STUDIO=true', async () => {
    vi.stubEnv('VITE_MOCK_STUDIO', 'true')
    const on = (await import('./handlers')).handlers.length
    vi.resetModules()
    vi.stubEnv('VITE_MOCK_STUDIO', 'false')
    const off = (await import('./handlers')).handlers.length
    expect(on).toBeGreaterThan(off)
  })
})

// Server contact-sheet + frame-grab mocks (mirrors the /api/video/concat and
// /api/video/extract-audio fire-and-poll shape). Runs its own MSW server over a
// freshly-imported, env-stubbed `handlers` module (same pattern as
// `useScenePipeline.serverExtract.test.tsx`) so this file's other describe's
// `vi.resetModules()` churn can't leave a stale module instance behind.
describe('server frame mocks', () => {
  let server: ReturnType<typeof setupServer>

  installMswRelativeUrlShim()

  beforeAll(async () => {
    vi.resetModules()
    vi.stubEnv('VITE_MOCK_STUDIO', 'true')
    const { handlers } = await import('./handlers')
    server = setupServer(...handlers)
    server.listen({ onUnhandledRequest: 'error' })
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  async function pollDone(jobId: string): Promise<unknown> {
    for (let i = 0; i < 5; i++) {
      const job = (await (await fetch(`/api/studio/job?id=${jobId}`)).json()) as { status: string; result?: unknown }
      if (job.status === 'done') return job.result
    }
    throw new Error('mock job never finished')
  }

  it('contact-sheet tiles 12 per sheet and coerces through toServerSheets', async () => {
    const times = Array.from({ length: 14 }, (_, i) => i)
    const res = await fetch('/api/video/contact-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: '/api/uploads/projects/p1/source/a.mp4', projectId: 'p1', times, labels: times.map(String) }),
    })
    const { jobId } = (await res.json()) as { jobId: string }
    const sheets = toServerSheets(await pollDone(jobId))
    expect(sheets.map((s) => s.times.length)).toEqual([12, 2])
    expect(sheets[0].url).toMatch(/^\/api\/uploads\/projects\/p1\/thumbnails\/server\//)
  })

  it('frames returns one url per time and coerces through toServerFrames', async () => {
    const res = await fetch('/api/video/frames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: '/api/uploads/projects/p1/source/a.mp4', projectId: 'p1', times: [3, 9], height: 720 }),
    })
    const { jobId } = (await res.json()) as { jobId: string }
    const frames = toServerFrames(await pollDone(jobId))
    expect(frames.map((f) => f.time)).toEqual([3, 9])
  })

  it('frames refuses a height the rule has no step for, like the rule', async () => {
    const res = await fetch('/api/video/frames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: '/api/uploads/projects/p1/source/a.mp4', projectId: 'p1', times: [3], height: 500 }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'height must be one of 180, 720, 1080', code: 'BAD_REQUEST' })
  })
})
