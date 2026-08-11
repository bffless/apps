import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
