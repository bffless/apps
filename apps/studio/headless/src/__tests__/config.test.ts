import { describe, it, expect } from 'vitest'
import { parseVideoUrls, loadConfig } from '../config'

describe('parseVideoUrls', () => {
  it('splits on newlines and commas, trims, drops blanks', () => {
    expect(parseVideoUrls('https://a/x.mp4\n https://b/y.mp4 ,\n'))
      .toEqual(['https://a/x.mp4', 'https://b/y.mp4'])
  })
  it('rejects empty input', () => {
    expect(() => parseVideoUrls('  \n')).toThrow(/video_urls/i)
  })
  it('rejects non-http(s) URLs', () => {
    expect(() => parseVideoUrls('ftp://a/x.mp4')).toThrow(/protocol/i)
  })
})

describe('loadConfig', () => {
  const base = {
    STUDIO_BASE_URL: 'https://studio.example.dev',
    VIDEO_URLS: 'https://a/x.mp4',
    STUDIO_USER_EMAIL: 'u@example.com',
    STUDIO_USER_PASSWORD: 'pw',
  }
  it('builds a real-mode config', () => {
    const cfg = loadConfig(base as never)
    expect(cfg.mockMode).toBe(false)
    expect(cfg.credentials).toEqual({ email: 'u@example.com', password: 'pw' })
    expect(cfg.buildTimeoutMs).toBe(90 * 60_000) // default
  })
  it('requires credentials outside mock mode', () => {
    expect(() => loadConfig({ ...base, STUDIO_USER_EMAIL: '' } as never)).toThrow(/STUDIO_USER_EMAIL/)
  })
  it('mock mode takes FIXTURE_PATHS instead of URLs and needs no credentials', () => {
    const cfg = loadConfig({ STUDIO_BASE_URL: 'http://localhost:5173', MOCK_MODE: 'true', FIXTURE_PATHS: '/tmp/f.mp4' } as never)
    expect(cfg.mockMode).toBe(true)
    expect(cfg.fixturePaths).toEqual(['/tmp/f.mp4'])
    expect(cfg.credentials).toBeNull()
  })
  it('reads the smoke stop flag', () => {
    const cfg = loadConfig({ STUDIO_BASE_URL: 'http://localhost:5173', MOCK_MODE: 'true', FIXTURE_PATHS: '/tmp/f.mp4', SMOKE_STOP_AFTER_START: 'true' } as never)
    expect(cfg.smokeStopAfterStart).toBe(true)
  })
})
