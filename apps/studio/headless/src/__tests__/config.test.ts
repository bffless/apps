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
    expect(cfg.buildStallTimeoutMs).toBe(20 * 60_000) // default
  })

  it('takes a build stall ceiling from the environment', () => {
    const cfg = loadConfig({ ...base, BUILD_STALL_MINUTES: '5' } as never)
    expect(cfg.buildStallTimeoutMs).toBe(5 * 60_000)
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

  it('defaults to the single-threaded ffmpeg core; FFMPEG_MT=true opts back in', () => {
    const base = { STUDIO_BASE_URL: 'http://localhost:5173', MOCK_MODE: 'true', FIXTURE_PATHS: '/tmp/f.mp4' }
    expect(loadConfig(base as never).ffmpegMt).toBe(false)
    expect(loadConfig({ ...base, FFMPEG_MT: 'true' } as never).ffmpegMt).toBe(true)
  })

  it('VIDEO_BACKEND: unset → null, a known backend passes through, anything else throws', () => {
    const base = { STUDIO_BASE_URL: 'http://localhost:5173', MOCK_MODE: 'true', FIXTURE_PATHS: '/tmp/f.mp4' }
    expect(loadConfig(base as never).videoBackend).toBeNull()
    expect(loadConfig({ ...base, VIDEO_BACKEND: '' } as never).videoBackend).toBeNull()
    expect(loadConfig({ ...base, VIDEO_BACKEND: 'remote' } as never).videoBackend).toBe('remote')
    expect(loadConfig({ ...base, VIDEO_BACKEND: ' wasm ' } as never).videoBackend).toBe('wasm')
    expect(() => loadConfig({ ...base, VIDEO_BACKEND: 'bogus' } as never)).toThrow(/video_backend.*bogus/)
  })

  it('defaults the export inputs off/empty', () => {
    const cfg = loadConfig(base as never)
    expect(cfg.thumbnailPrompt).toBe('')
    expect(cfg.thumbnailReferenceUrl).toBeNull()
    expect(cfg.generateBlog).toBe(false)
    expect(cfg.blogDirection).toBe('')
    expect(cfg.describeTimeoutMs).toBe(5 * 60_000)
    expect(cfg.thumbnailTimeoutMs).toBe(10 * 60_000)
    expect(cfg.blogTimeoutMs).toBe(15 * 60_000)
  })

  it('reads the export inputs', () => {
    const cfg = loadConfig({
      ...base,
      THUMBNAIL_PROMPT: 'sketch of me, S01 EP28',
      THUMBNAIL_REFERENCE_URL: 'https://files.example.dev/r/abc/face.png?token=t',
      GENERATE_BLOG: 'true',
      BLOG_DIRECTION: 'friendly tone, lead with the demo',
    } as never)
    expect(cfg.thumbnailPrompt).toBe('sketch of me, S01 EP28')
    expect(cfg.thumbnailReferenceUrl).toBe('https://files.example.dev/r/abc/face.png?token=t')
    expect(cfg.generateBlog).toBe(true)
    expect(cfg.blogDirection).toBe('friendly tone, lead with the demo')
  })

  it('rejects a malformed or non-http thumbnail reference URL', () => {
    expect(() => loadConfig({ ...base, THUMBNAIL_REFERENCE_URL: 'not a url' } as never))
      .toThrow(/thumbnail_reference_url/)
    expect(() => loadConfig({ ...base, THUMBNAIL_REFERENCE_URL: 'ftp://x/face.png' } as never))
      .toThrow(/protocol/)
  })
})
