import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveVideoBackend, getVideoBackend, resetVideoBackendForTests } from './videoBackend'

describe('resolveVideoBackend (pure)', () => {
  it('a ?videoBackend override beats everything', () => {
    expect(resolveVideoBackend('?videoBackend=wasm', null, { server: true })).toBe('wasm')
    expect(resolveVideoBackend('?videoBackend=server', null, { server: false })).toBe('server')
  })
  it('a stored choice beats the probe', () => {
    expect(resolveVideoBackend('', 'wasm', { server: true })).toBe('wasm')
  })
  it('defaults by probe capability', () => {
    expect(resolveVideoBackend('', null, { server: true })).toBe('server')
    expect(resolveVideoBackend('', null, { server: false })).toBe('wasm')
    expect(resolveVideoBackend('', null, null)).toBe('wasm')
  })
  it('garbage values fall through to the probe default', () => {
    expect(resolveVideoBackend('?videoBackend=nope', 'nope', { server: true })).toBe('server')
  })
})

describe('getVideoBackend (session memo)', () => {
  afterEach(() => {
    resetVideoBackendForTests()
    vi.unstubAllGlobals()
  })

  it('probes once and memoizes — concurrent callers share one fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ server: true, ops: ['probe', 'slice'], version: 'ffmpeg 7' })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const [a, b] = await Promise.all([getVideoBackend(), getVideoBackend()])
    expect(a).toBe('server')
    expect(b).toBe('server')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never rejects: probe failure resolves wasm (spec: older CE runs exactly as today)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(getVideoBackend()).resolves.toBe('wasm')
  })

  it('non-JSON / 404 responses resolve wasm', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 404 })))
    await expect(getVideoBackend()).resolves.toBe('wasm')
  })
})
